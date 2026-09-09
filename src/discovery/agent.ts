/**
 * Discovery agent: observe -> decide -> act, with the model in the loop exactly once per action.
 *
 * Everything the model asks for goes through the same PolicyEngine the replay engine uses, before
 * it touches the surface. Blocked actions are fed back to the model as a result, not silently
 * dropped, so it can choose a different path. Every turn is logged with the rendered observation
 * the model saw, its tool call, and a screenshot.
 */
import type { AppProfile, Capability } from '../artifact/schema.js';
import { evalCheckpoint } from '../artifact/conditions.js';
import { Evidence } from '../evidence/evidence.js';
import { SessionController } from '../handoff/control.js';
import { PolicyEngine } from '../policy/policy.js';
import type { Surface, Observation, SurfaceAction } from '../surface/types.js';
import type { LLM, LLMMessage, ToolCall } from './llm.js';
import { renderObservation, systemPrompt, TOOLS, type GoalSpec } from './prompts.js';
import { Recorder, type Annotations } from './recorder.js';

export interface DiscoveryOptions {
  capabilityId: string;
  goal: GoalSpec;
  entryUrl: string;
  profile: AppProfile;
  tenant: string;
  maxSteps?: number;
  timeoutMs?: number;
}

export type DiscoveryResult =
  | { status: 'success'; capability: Capability; summary: string; steps: number }
  | { status: 'stopped'; reason: string; steps: number };

export class DiscoveryAgent {
  private history: string[] = [];
  private interventions = 0;

  constructor(
    private surface: Surface,
    private llm: LLM,
    private policy: PolicyEngine,
    private evidence: Evidence,
    private control: SessionController,
  ) {}

  async run(opts: DiscoveryOptions): Promise<DiscoveryResult> {
    const maxSteps = opts.maxSteps ?? 25;
    const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60 * 1000);
    const recorder = new Recorder({
      id: opts.capabilityId,
      goal: opts.goal.goal,
      entryUrl: opts.entryUrl,
      profileId: opts.profile.id,
      tenant: opts.tenant,
      inputs: opts.goal.inputs,
      model: this.llm.model,
      runId: this.evidence.runId,
    });
    const sys = systemPrompt(opts.goal);
    this.evidence.log('discovery.start', { goal: opts.goal.goal, entryUrl: opts.entryUrl, model: this.llm.model, maxSteps, inputs: Object.keys(opts.goal.inputs) });
    this.evidence.writeText('system-prompt.txt', sys);

    await this.surface.act({ kind: 'navigate', url: opts.entryUrl });
    let lastResult: string | undefined;

    for (let step = 1; step <= maxSteps; step++) {
      if (Date.now() > deadline) return this.stop('timeout', step, 'discovery timed out');
      this.control.assertAutomationMayAct();
      const obs = await this.surface.observe();
      const detected = opts.profile.conditions.filter((c) => evalCheckpoint(c.detect, obs).ok).map((c) => `${c.code} (${c.kind}: ${c.description})`);
      const rendered = renderObservation(obs, { detected, lastResult, step, maxSteps });
      const shot = await this.evidence.shot(this.surface, `step${step}-observe`);
      this.evidence.log('observe', { step, url: obs.url, elements: obs.elements.length, detected, dialogs: obs.dialogs, screenshot: shot });
      this.evidence.writeText(`observations/step${String(step).padStart(2, '0')}.txt`, rendered);

      const messages: LLMMessage[] = [
        { role: 'system', content: sys },
        ...(this.history.length ? [{ role: 'user' as const, content: 'HISTORY OF THIS RUN SO FAR:\n' + this.history.map((h, i) => `${i + 1}. ${h}`).join('\n') }] : []),
        { role: 'user', content: rendered },
      ];
      const decision = await this.llm.decide(messages, TOOLS);
      const call = decision.calls[0];
      this.evidence.log('decide', { step, model: decision.model, call, usage: decision.usage, text: decision.text });
      if (!call) {
        lastResult = 'ERROR: you must call exactly one tool';
        continue;
      }

      const r = await this.execute(call, obs, recorder, opts, step);
      this.history.push(`${describeCall(call)} -> ${r.result}`);
      lastResult = r.result;
      if (r.done) {
        const cap = recorder.finalize(r.done, await this.annotate(opts, recorder, r.done.summary));
        cap.provenance.humanInterventions = this.interventions;
        this.evidence.log('discovery.success', { steps: step, summary: r.done.summary, capability: cap.id });
        return { status: 'success', capability: cap, summary: r.done.summary, steps: step };
      }
      if (r.abort) return this.stop('aborted', step, r.abort);
    }
    return this.stop('max_steps', maxSteps, `no success after ${maxSteps} steps`);
  }

  private stop(kind: string, steps: number, reason: string): DiscoveryResult {
    this.evidence.log('discovery.stopped', { kind, reason, steps });
    return { status: 'stopped', reason, steps };
  }

  private async execute(
    call: ToolCall,
    obs: Observation,
    recorder: Recorder,
    opts: DiscoveryOptions,
    step: number,
  ): Promise<{ result: string; done?: { obs: Observation; evidenceText: string; summary: string }; abort?: string }> {
    const a = call.args ?? {};
    const el = typeof a.ref === 'number' ? obs.elements.find((e) => e.ref === a.ref) : undefined;
    const needsEl = ['click', 'type', 'select', 'extract'].includes(call.name);
    if (needsEl && !el) return { result: `ERROR: ref ${a.ref} is not in the current observation` };

    switch (call.name) {
      case 'done': {
        if (!a.evidenceText || !obs.text.toLowerCase().includes(String(a.evidenceText).toLowerCase())) {
          return { result: `ERROR: evidenceText "${a.evidenceText}" is not visible on the current screen; pick exact visible text` };
        }
        return { result: 'done', done: { obs, evidenceText: String(a.evidenceText), summary: String(a.summary ?? '') } };
      }
      case 'stuck':
        return this.escalate(String(a.reason ?? 'model reported stuck'), String(a.needed ?? ''), obs, opts, step);
      case 'declare_outcome': {
        recorder.declareOutcome(String(a.code), String(a.textPresent), String(a.description));
        this.evidence.log('outcome.declared', { code: a.code, textPresent: a.textPresent });
        return { result: `outcome ${a.code} recorded` };
      }
      case 'extract': {
        const verdict = this.policy.authorize({ kind: 'extract' }, { phase: 'discovery' }, el, obs.url);
        if (!verdict.allowed) return { result: `BLOCKED: ${verdict.reason}` };
        const value = el!.text || el!.attrs.value || el!.name;
        recorder.record({ kind: 'extract', element: el!, before: obs, reason: String(a.reason ?? ''), risk: 'safe', output: { name: String(a.name), type: a.type ?? 'string' } });
        this.evidence.log('extract', { step, name: a.name, outputType: a.type, ref: a.ref, value, target: el!.name || el!.anchor });
        return { result: `extracted ${a.name} = "${value}"` };
      }
      case 'click':
      case 'type':
      case 'select': {
        const action = this.toAction(call, el!, opts);
        if ('error' in action) return { result: `ERROR: ${action.error}` };
        const verdict = this.policy.authorize(action.action, { phase: 'discovery', allowIrreversible: opts.goal.allowIrreversible, modelAcknowledged: !!a.confirmIrreversible }, el, obs.url);
        this.evidence.log('policy', { step, action: redactAction(action.action), risk: verdict.risk, allowed: verdict.allowed, reason: verdict.reason });
        if (!verdict.allowed) return { result: `BLOCKED by policy: ${verdict.reason}` };
        this.control.assertAutomationMayAct();
        try {
          await this.surface.act(action.action);
        } catch (e: any) {
          const bundle = await this.evidence.failureBundle(this.surface, `step${step}-act`);
          this.evidence.log('act.error', { step, error: String(e?.message ?? e), ...bundle });
          return { result: `ERROR: action failed: ${String(e?.message ?? e).split('\n')[0]}` };
        }
        const after = await this.surface.observe();
        const dialog = after.dialogs.find((d) => d.handledAs === 'accepted');
        const dismissed = after.dialogs.find((d) => d.handledAs === 'dismissed');
        recorder.record({ kind: call.name, element: el!, before: obs, after, reason: String(a.reason ?? ''), risk: verdict.risk, value: action.value, acceptedDialog: dialog?.message, dismissedDialog: dismissed?.message });
        this.evidence.log('act', { step, action: redactAction(action.action), risk: verdict.risk, urlAfter: after.url, dialogs: after.dialogs });
        const dialogNote = after.dialogs.length ? ` (dialog ${after.dialogs.map((d) => `"${d.message}" ${d.handledAs}`).join('; ')})` : '';
        return { result: `ok${dialogNote}` };
      }
      default:
        return { result: `ERROR: unknown tool ${call.name}` };
    }
  }

  private toAction(call: ToolCall, el: Observation['elements'][number], opts: DiscoveryOptions): { action: SurfaceAction; value?: Recorder['steps'][number]['value'] } | { error: string } {
    const a = call.args;
    if (call.name === 'click') return { action: { kind: 'click', ref: el.ref, acceptDialog: !!a.acceptDialog } };
    if (call.name === 'select') return { action: { kind: 'select', ref: el.ref, option: String(a.option) }, value: this.recorderValue(String(a.option), opts) };
    // type
    if (a.secretRef) {
      const envName = opts.profile.secrets[a.secretRef] ?? (opts.goal.secretRefs.includes(a.secretRef) ? a.secretRef : undefined);
      if (!envName) return { error: `unknown secretRef "${a.secretRef}"` };
      const v = process.env[envName];
      if (!v) return { error: `secret ${a.secretRef} is not configured in the environment (${envName})` };
      return { action: { kind: 'type', ref: el.ref, text: v }, value: { kind: 'secret', ref: envName } };
    }
    if (typeof a.text !== 'string') return { error: 'type requires text or secretRef' };
    if (el.role === 'password') return { error: 'never type literal text into a password field; use secretRef' };
    return { action: { kind: 'type', ref: el.ref, text: a.text }, value: this.recorderValue(a.text, opts) };
  }

  private recorderValue(text: string, opts: DiscoveryOptions) {
    for (const [name, spec] of Object.entries(opts.goal.inputs)) if (spec.value === text) return { kind: 'param' as const, name };
    return { kind: 'literal' as const, value: text };
  }

  private async escalate(reason: string, needed: string, obs: Observation, opts: DiscoveryOptions, step: number) {
    const shot = await this.evidence.shot(this.surface, `step${step}-escalate`);
    this.evidence.log('escalate', { step, reason, needed, screenshot: shot });
    const resolution = await this.control.requestIntervention({
      runId: this.evidence.runId,
      phase: 'discovery',
      capability: opts.capabilityId,
      goal: opts.goal.goal,
      stepIndex: step,
      reason,
      cause: `model reported stuck: ${reason}`,
      url: obs.url,
      screenshot: shot,
      observationSummary: obs.text.slice(0, 600),
      suggestedActions: [needed],
    });
    this.interventions++;
    this.evidence.log('escalate.resolved', { step, action: resolution.action, operator: resolution.operator, note: resolution.note, humanActions: resolution.humanActions });
    if (resolution.action === 'abort') return { result: 'aborted by operator', abort: `operator aborted: ${resolution.note}` };
    return { result: `a human operator (${resolution.operator}) intervened and handed control back: "${resolution.note}". Re-read the screen and continue.` };
  }

  /** One extra model call to write reviewer-facing names and descriptions. Falls back to defaults offline. */
  private async annotate(opts: DiscoveryOptions, recorder: Recorder, summary: string): Promise<Annotations | undefined> {
    try {
      const steps = recorder.steps.map((s) => `${s.id}: ${s.kind} ${s.target?.description ?? ''} - ${s.description}`).join('\n');
      const res = await this.llm.json<Annotations>(
        `Goal: ${opts.goal.goal}\nInputs: ${Object.keys(opts.goal.inputs).join(', ')}\nOutputs: ${recorder.steps.filter((s) => s.output).map((s) => s.output).join(', ')}\nSteps:\n${steps}\nRun summary: ${summary}\n\nWrite a short human-readable name (Title Case, <= 6 words), a one-paragraph description of what this capability does and returns, and one-sentence descriptions for each input and output.`,
        `{"name": string, "description": string, "inputs": {<inputName>: string}, "outputs": {<outputName>: string}}`,
      );
      return res && typeof res === 'object' ? res : undefined;
    } catch {
      return undefined;
    }
  }
}

function describeCall(c: ToolCall): string {
  const { reason, ...rest } = c.args ?? {};
  if (rest.secretRef) rest.text = undefined;
  return `${c.name}(${JSON.stringify(rest)})${reason ? ` because "${reason}"` : ''}`;
}

/** Typed text is logged as-is; the Evidence redactor masks secret and pii values before anything is written. */
function redactAction(a: SurfaceAction): SurfaceAction {
  return a;
}
