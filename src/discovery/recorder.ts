/**
 * Recorder: turns what the discovery agent did into a Capability artifact.
 *
 * The model transcript is *not* the artifact. Each action is re-expressed as a step with a
 * TargetSpec (a fallback chain built from the element as observed), a value reference (param /
 * secret / literal: typed values are parameterized by matching them against declared inputs), a
 * risk class from the policy engine, and a post-condition derived from what actually changed on
 * screen after the action (a frame navigating to a new route becomes `expect.urlMatches`).
 */
import type { Capability, OutcomeSpec, Step, ValueRef, Checkpoint, ParamSpec, OutputSpec } from '../artifact/schema.js';
import { buildTarget, urlToPattern } from '../surface/locator.js';
import type { Observation, ObservedElement } from '../surface/types.js';
import type { Risk } from '../artifact/schema.js';

export interface RecordInput {
  kind: 'click' | 'type' | 'select' | 'extract';
  element: ObservedElement;
  before: Observation;
  after?: Observation;
  reason: string;
  risk: Risk;
  value?: ValueRef;
  output?: { name: string; type: OutputSpec['type'] };
  acceptedDialog?: string;
  dismissedDialog?: string;
}

export interface RecorderOptions {
  id: string;
  goal: string;
  entryUrl: string;
  profileId: string;
  tenant: string;
  inputs: Record<string, { value: string; sensitivity: 'none' | 'pii' | 'secret' }>;
  model?: string;
  runId: string;
}

export class Recorder {
  readonly steps: Step[] = [];
  readonly outcomes: OutcomeSpec[] = [];
  private outputs: Record<string, OutputSpec> = {};
  private visited = new Set<string>();
  private n = 0;

  constructor(readonly opts: RecorderOptions) {
    this.noteVisited(entryUrlOf(opts.entryUrl));
  }

  noteVisited(obsOrUrl: Observation | string) {
    if (typeof obsOrUrl === 'string') this.visited.add(urlToPattern(obsOrUrl));
    else for (const f of [obsOrUrl.url, ...obsOrUrl.frames.map((x) => x.url)]) this.visited.add(urlToPattern(f));
  }

  private lastDismissed: { stepId: string; fingerprint: string } | null = null;

  record(r: RecordInput): Step {
    const target = buildTarget(r.element, r.before.frames);
    // A click that only produced a (dismissed) confirm() dialog, immediately followed by the same
    // click accepting it, is one logical step: "click Confirm and accept the dialog".
    if (r.acceptedDialog && this.lastDismissed && this.lastDismissed.fingerprint === JSON.stringify(target.fingerprint) && this.steps[this.steps.length - 1]?.id === this.lastDismissed.stepId) {
      this.steps.pop();
      this.n--;
    }
    const id = `s${++this.n}_${r.kind}`;
    this.lastDismissed = r.dismissedDialog && !r.acceptedDialog ? { stepId: id, fingerprint: JSON.stringify(target.fingerprint) } : null;
    const step: Step = {
      id,
      kind: r.kind,
      description: r.reason,
      target,
      risk: r.risk,
    };
    if (r.value) step.value = r.value;
    if (r.output) {
      step.output = r.output.name;
      step.parse = r.output.type === 'money' ? 'money' : r.output.type === 'number' ? 'number' : 'text';
      this.outputs[r.output.name] = { type: r.output.type, description: r.reason, sensitivity: 'none', fromStep: id };
    }
    if (r.acceptedDialog) step.dialog = { expect: 'confirm', respond: 'accept' };
    if (r.after) {
      const expect = deriveExpect(r.before, r.after);
      if (expect) step.expect = expect;
      this.noteVisited(r.after);
    }
    this.steps.push(step);
    return step;
  }

  declareOutcome(code: string, textPresent: string, description: string) {
    if (this.outcomes.some((o) => o.code === code)) return;
    this.outcomes.push({ code, kind: 'business', description, detect: { any: [{ textPresent }] }, captureMessage: `(${escapeRe(textPresent)}[^.]*\\.?)` });
  }

  /** Parameterize a typed value: an input's value becomes {param}, otherwise a literal. */
  valueRefFor(text: string): ValueRef {
    for (const [name, spec] of Object.entries(this.opts.inputs)) {
      if (spec.value === text) return { kind: 'param', name };
    }
    return { kind: 'literal', value: text };
  }

  finalize(final: { obs: Observation; evidenceText: string; summary: string }, annotations?: Annotations): Capability {
    const mainFrame = final.obs.frames.length > 1 ? final.obs.frames[final.obs.frames.length - 1] : { url: final.obs.url };
    const success: Checkpoint = { all: [{ urlMatches: urlToPattern(mainFrame.url) }, { textPresent: final.evidenceText }] };
    const inputs: Record<string, ParamSpec> = {};
    for (const [name, spec] of Object.entries(this.opts.inputs)) {
      inputs[name] = {
        type: /^\d+(\.\d+)?$/.test(spec.value) && !/^\d{4,}$/.test(spec.value) ? 'number' : 'string',
        description: annotations?.inputs?.[name] ?? `Value for ${name}`,
        required: true,
        sensitivity: spec.sensitivity,
        example: spec.sensitivity === 'none' ? spec.value : undefined,
        pattern: /^\d{5}$/.test(spec.value) ? '^\\d{5}$' : undefined,
      };
    }
    const outputs = { ...this.outputs };
    for (const [name, o] of Object.entries(outputs)) if (annotations?.outputs?.[name]) o.description = annotations.outputs[name];

    const origin = new URL(this.opts.entryUrl).origin;
    const steps: Step[] = [
      { id: 's0_navigate', kind: 'navigate', description: 'Open the application entry point', url: this.opts.entryUrl, risk: 'safe', expect: { all: [{ urlMatches: urlToPattern(this.opts.entryUrl) }] } },
      ...this.steps,
    ];
    const maxRisk = steps.reduce<Risk>((m, s) => (rankRisk(s.risk) > rankRisk(m) ? s.risk : m), 'safe');
    // Input values must not be baked into prose: "member 10001" becomes "member {memberId}".
    const ph = (t: string) => {
      let out = t;
      for (const [name, spec] of Object.entries(this.opts.inputs)) if (spec.value.length >= 3) out = out.split(spec.value).join(`{${name}}`);
      return out;
    };
    for (const s of steps) {
      s.description = ph(s.description);
      if (s.target) {
        s.target.description = ph(s.target.description);
        s.target.fingerprint.name = ph(s.target.fingerprint.name);
        if (s.target.fingerprint.anchor) s.target.fingerprint.anchor = ph(s.target.fingerprint.anchor);
        for (const st of s.target.strategies) for (const k of ['anchor', 'name', 'text', 'row', 'column'] as const) if (k in st && typeof (st as any)[k] === 'string') (st as any)[k] = ph((st as any)[k]);
      }
    }
    for (const o of Object.values(outputs)) o.description = ph(o.description);
    return {
      schemaVersion: '1.0',
      id: this.opts.id,
      version: 1,
      status: 'draft',
      name: ph(annotations?.name ?? this.opts.id.replace(/_/g, ' ')),
      description: ph(annotations?.description ?? final.summary),
      app: { profile: this.opts.profileId, surface: 'web', entryUrl: this.opts.entryUrl },
      inputs,
      outputs,
      outcomes: this.outcomes,
      steps,
      success,
      policy: {
        allowlist: { origins: [origin], routes: [...this.visited].sort(), actions: ['navigate', 'click', 'type', 'select', 'extract', 'assert', 'dismiss'] },
        maxRisk,
      },
      provenance: {
        recordedAt: new Date().toISOString(),
        recordedBy: 'discovery',
        model: this.opts.model,
        discoveryRunId: this.opts.runId,
        goal: this.opts.goal,
        tenant: this.opts.tenant,
      },
    };
  }
}

export interface Annotations {
  name?: string;
  description?: string;
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
}

/** What changed after the action becomes the step's post-condition. */
function deriveExpect(before: Observation, after: Observation): Checkpoint | undefined {
  const b = new Map(before.frames.map((f) => [f.path, f.url]));
  for (const f of after.frames) {
    const prev = b.get(f.path);
    if (prev !== f.url) return { all: [{ urlMatches: urlToPattern(f.url) }] };
  }
  if (before.url !== after.url) return { all: [{ urlMatches: urlToPattern(after.url) }] };
  return undefined;
}

function entryUrlOf(u: string) {
  return u;
}
function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function rankRisk(r: Risk) {
  return r === 'safe' ? 0 : r === 'reversible' ? 1 : 2;
}
