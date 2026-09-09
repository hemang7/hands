/**
 * Deterministic replay engine. No model anywhere in this file.
 *
 * Per step:  detect conditions -> resolve target -> authorize -> act -> verify post-condition
 *
 * Conditions are checked *before* every step and again when a post-condition fails, using the
 * merged vocabulary of tenant overrides + capability outcomes + app profile conditions. Each
 * outcome kind maps to exactly one behaviour:
 *   business    -> stop, return {status:'outcome'} with the app's own message
 *   recoverable -> run its recovery (dismiss / reauth / retry), then retry the step
 *   hard        -> stop, return {status:'failed'} with a failure bundle
 * Anything the engine cannot classify (target not found after retries, an irreversible step it is
 * not authorized to take) is escalated to a human on the live session; the human's decision
 * (resume / skip / abort) drives what happens next.
 */
import { evalCheckpoint, describeCheckpoint } from '../artifact/conditions.js';
import type { AppProfile, Capability, OutcomeSpec, Step, TenantOverride } from '../artifact/schema.js';
import type { CapabilityStore } from '../artifact/store.js';
import { Evidence } from '../evidence/evidence.js';
import { SessionController } from '../handoff/control.js';
import { PolicyEngine } from '../policy/policy.js';
import { Redactor } from '../policy/redact.js';
import { buildTarget, resolveTarget } from '../surface/locator.js';
import type { Observation, Resolved, Surface, SurfaceAction } from '../surface/types.js';
import type { DriftWarning, Failure, InterventionRecord, RecoveryRecord, ReplayResult, StepReport } from './result.js';

export interface ReplayRequest {
  capability: Capability;
  inputs: Record<string, string>;
  tenant?: string;
  /** Caller's explicit consent to irreversible steps (still requires an approved artifact). */
  confirm?: boolean;
  stepTimeoutMs?: number;
}

export class ReplayEngine {
  constructor(
    private surface: Surface,
    private store: CapabilityStore,
    private evidence: Evidence,
    private control: SessionController,
    private redactor: Redactor,
  ) {}

  async run(req: ReplayRequest): Promise<ReplayResult> {
    const startedAt = new Date();
    const cap = req.capability;
    const profile = this.store.loadProfile(cap.app.profile);
    const tenant = req.tenant ?? cap.provenance.tenant ?? 'default';
    const override = cap.tenants?.[tenant];
    const entryUrl = override?.entryUrl ?? profile.tenants[tenant]?.entryUrl ?? cap.app.entryUrl;
    const steps = applyOverrides(cap.steps, override, entryUrl, cap.app.entryUrl);
    const outcomes: OutcomeSpec[] = [...(override?.outcomes ?? []), ...cap.outcomes, ...profile.conditions];
    const origins = new Set([...cap.policy.allowlist.origins, new URL(entryUrl).origin]);
    const policy = new PolicyEngine({
      allowlist: { origins: [...origins], routes: cap.policy.allowlist.routes.map((r) => retarget(r, cap.app.entryUrl, entryUrl)), actions: cap.policy.allowlist.actions },
      irreversibleControlPattern: profile.irreversibleControlPattern,
    });
    const auth = { phase: 'replay' as const, artifactApproved: cap.status === 'approved', callerConfirmed: !!req.confirm };

    const reports: StepReport[] = steps.map((s) => ({ id: s.id, kind: s.kind, status: 'not_run', attempts: 0, durationMs: 0 }));
    const drift: DriftWarning[] = [];
    const recoveries: RecoveryRecord[] = [];
    const interventions: InterventionRecord[] = [];
    const outputs: Record<string, string | number | boolean> = {};
    const base = () => ({
      runId: this.evidence.runId,
      capability: { id: cap.id, version: cap.version, status: cap.status },
      tenant,
      inputs: req.inputs,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      steps: reports,
      drift,
      recoveries,
      interventions,
      evidenceDir: this.evidence.dir,
    });

    this.evidence.log('replay.start', { capability: cap.id, version: cap.version, status: cap.status, tenant, entryUrl, inputs: req.inputs, steps: steps.length, outcomesKnown: outcomes.map((o) => o.code) });

    // ---- input validation: fail before touching the surface ----
    const invalid = validateInputs(cap, req.inputs);
    if (invalid) {
      this.evidence.log('replay.failed', { code: 'INVALID_INPUT', message: invalid });
      return { ...base(), status: 'failed', failure: { code: 'INVALID_INPUT', message: invalid } };
    }
    for (const [name, spec] of Object.entries(cap.inputs)) if (spec.sensitivity !== 'none') this.redactor.addPii(req.inputs[name]);

    let restarts = 0;
    let i = 0;
    while (i < steps.length) {
      const step = steps[i];
      const rep = reports[i];
      const t0 = Date.now();
      rep.attempts++;
      const timeoutMs = step.timeoutMs ?? req.stepTimeoutMs ?? 6000;
      this.control.assertAutomationMayAct();

      // ---- 1. observe + detect known conditions before acting ----
      const obs = await this.surface.observe();
      // A navigate step leaves the current screen, so whatever is on it now is not a condition to act on.
      const cond = step.kind === 'navigate' ? null : detect(outcomes, obs);
      if (cond) {
        const handled = await this.handleCondition(cond, step, obs, outcomes, reports, recoveries, i, restarts);
        if (handled.result) {
          rep.status = handled.result.status === 'outcome' ? 'ok' : 'failed';
          rep.durationMs += Date.now() - t0;
          return { ...base(), ...handled.result } as ReplayResult;
        }
        if (handled.restart) {
          restarts++;
          i = 0;
          continue;
        }
        if (handled.retry) {
          rep.status = 'recovered';
          rep.durationMs += Date.now() - t0;
          continue; // same step, fresh observation
        }
      }

      // ---- 2. resolve target ----
      let resolved: Resolved | null = null;
      if (step.target) {
        resolved = resolveTarget(step.target, obs);
        if (!resolved && rep.attempts < 3) {
          // Give a slow frame one more chance before declaring the control missing.
          await this.surface.waitQuiescent(1500);
          this.evidence.log('resolve.retry', { step: step.id, attempt: rep.attempts });
          rep.durationMs += Date.now() - t0;
          continue;
        }
        if (!resolved) {
          const bundle = await this.evidence.failureBundle(this.surface, step.id);
          this.evidence.log('resolve.failed', { step: step.id, target: step.target.description, strategies: step.target.strategies.map((s) => s.kind), ...bundle });
          const failure: Failure = { code: 'TARGET_NOT_FOUND', stepId: step.id, message: `could not locate ${step.target.description}`, expected: JSON.stringify(step.target.strategies), observed: summarize(obs), evidence: bundle };
          const decision = await this.escalate(step, i, obs, failure, interventions, bundle.screenshot);
          if (decision === 'retry') continue;
          if (decision === 'skip') {
            rep.status = 'skipped_by_human';
            i++;
            continue;
          }
          rep.status = 'failed';
          return { ...base(), status: 'escalated', failure };
        }
        rep.strategyUsed = resolved.strategyIndex === 0 ? resolved.strategy.kind : `${resolved.strategy.kind} (fallback #${resolved.strategyIndex + 1})`;
        rep.fingerprintScore = resolved.fingerprintScore;
        if (resolved.strategyIndex > 0) {
          const w: DriftWarning = {
            stepId: step.id,
            primary: step.target.strategies[0].kind,
            used: resolved.strategy.kind,
            strategyIndex: resolved.strategyIndex,
            message: `${step.target.description}: primary strategy "${step.target.strategies[0].kind}" did not match; matched via "${resolved.strategy.kind}"`,
            matchedTarget: buildTarget(resolved.element, obs.frames),
          };
          drift.push(w);
          this.evidence.log('drift', { ...w, matchedTarget: undefined });
        }
      }

      // ---- 3. build + authorize action ----
      const action = toAction(step, req.inputs, resolved, profile);
      if ('error' in action) {
        rep.status = 'failed';
        return { ...base(), status: 'failed', failure: { code: 'STEP_INVALID', stepId: step.id, message: action.error } };
      }
      if (action.action) {
        const verdict = policy.authorize(action.action, auth, resolved?.element, obs.url);
        this.evidence.log('policy', { step: step.id, risk: verdict.risk, allowed: verdict.allowed, reason: verdict.reason });
        if (!verdict.allowed) {
          const failure: Failure = { code: 'POLICY_BLOCKED', stepId: step.id, message: verdict.reason };
          if (verdict.risk === 'irreversible') {
            // Conservative: a person decides. They can perform the commit themselves and skip the step.
            const shot = await this.evidence.shot(this.surface, `${step.id}-needs-approval`);
            const decision = await this.escalate(step, i, obs, failure, interventions, shot);
            if (decision === 'retry') continue;
            if (decision === 'skip') {
              rep.status = 'skipped_by_human';
              i++;
              continue;
            }
            return { ...base(), status: 'escalated', failure };
          }
          rep.status = 'failed';
          return { ...base(), status: 'failed', failure };
        }
      }

      // ---- 4. act ----
      let slow = false;
      try {
        if (action.action) await this.surface.act(action.action);
      } catch (e: any) {
        if (String(e?.message).includes('did not settle')) slow = true;
        else {
          const bundle = await this.evidence.failureBundle(this.surface, step.id);
          this.evidence.log('act.error', { step: step.id, error: String(e?.message ?? e), ...bundle });
          rep.status = 'failed';
          return { ...base(), status: 'failed', failure: { code: 'ACTION_FAILED', stepId: step.id, message: String(e?.message ?? e).split('\n')[0], evidence: bundle } };
        }
      }
      if (slow) {
        // Recoverable: the host is slow, not broken. Wait longer, once, and record it.
        this.evidence.log('condition', { step: step.id, code: 'SLOW_LOAD', kind: 'recoverable', action: 'wait' });
        const ok = await this.surface.waitQuiescent(timeoutMs * 3);
        recoveries.push({ stepId: step.id, code: 'SLOW_LOAD', action: `waited up to ${timeoutMs * 3}ms`, succeeded: ok });
        if (!ok) {
          const bundle = await this.evidence.failureBundle(this.surface, step.id);
          rep.status = 'failed';
          return { ...base(), status: 'failed', failure: { code: 'TIMEOUT', stepId: step.id, message: `surface did not settle within ${timeoutMs * 3}ms after ${step.kind}`, evidence: bundle } };
        }
        rep.status = 'recovered';
      }

      // ---- 5. verify post-condition / extract ----
      const after = await this.surface.observe();
      const shot = await this.evidence.shot(this.surface, step.id);
      const unexpectedDialog = after.dialogs.find((d) => !step.dialog);
      if (unexpectedDialog) {
        recoveries.push({ stepId: step.id, code: 'UNEXPECTED_DIALOG', action: `dismissed "${unexpectedDialog.message}"`, succeeded: true });
        this.evidence.log('condition', { step: step.id, code: 'UNEXPECTED_DIALOG', kind: 'recoverable', message: unexpectedDialog.message });
      }
      if (step.kind === 'extract' && resolved) {
        const raw = resolved.element.text || resolved.element.attrs.value || resolved.element.name;
        const parsed = parseValue(raw, step.parse);
        if (parsed === undefined) {
          rep.status = 'failed';
          return { ...base(), status: 'failed', failure: { code: 'OUTPUT_UNPARSEABLE', stepId: step.id, message: `could not parse "${raw}" as ${step.parse}`, evidence: { screenshot: shot } } };
        }
        outputs[step.output!] = parsed;
        this.evidence.log('extract', { step: step.id, output: step.output, raw, parsed, screenshot: shot });
      }
      if (step.expect) {
        const ok = await this.waitFor(step.expect, timeoutMs, outcomes);
        if (!ok.ok) {
          // A failed post-condition is where business outcomes usually show up (submit -> "No record found").
          const cond = detect(outcomes, ok.obs);
          if (cond) {
            const handled = await this.handleCondition(cond, step, ok.obs, outcomes, reports, recoveries, i, restarts);
            if (handled.result) {
              rep.status = handled.result.status === 'outcome' ? 'ok' : 'failed';
              rep.durationMs += Date.now() - t0;
              return { ...base(), ...handled.result } as ReplayResult;
            }
            if (handled.restart) {
              restarts++;
              i = 0;
              continue;
            }
            if (handled.retry) {
              // The condition showed up *after* the action (e.g. a post-login notice). Now that it is
              // cleared, the post-condition may already hold; only redo the action if it does not.
              rep.status = 'recovered';
              const again = await this.waitFor(step.expect, timeoutMs, outcomes);
              this.evidence.log('checkpoint.recheck', { step: step.id, ok: again.ok, detail: again.detail });
              if (again.ok) {
                rep.durationMs += Date.now() - t0;
                i++;
              }
              continue;
            }
          }
          const bundle = await this.evidence.failureBundle(this.surface, step.id);
          this.evidence.log('checkpoint.failed', { step: step.id, expected: describeCheckpoint(step.expect), observed: ok.detail, ...bundle });
          rep.status = 'failed';
          return { ...base(), status: 'failed', failure: { code: 'CHECKPOINT_FAILED', stepId: step.id, message: `post-condition not met after ${step.kind}`, expected: describeCheckpoint(step.expect), observed: `${ok.detail}; ${summarize(ok.obs)}`, evidence: bundle } };
        }
      }
      if (rep.status === 'not_run') rep.status = 'ok';
      rep.durationMs += Date.now() - t0;
      this.evidence.log('step.ok', { step: step.id, kind: step.kind, strategy: rep.strategyUsed, attempts: rep.attempts, screenshot: shot });
      i++;
    }

    // ---- success condition + output contract ----
    const success = entryUrl === cap.app.entryUrl ? cap.success : { ...cap.success, all: cap.success.all?.map((c) => ('urlMatches' in c ? { urlMatches: retarget(c.urlMatches, cap.app.entryUrl, entryUrl) } : c)) };
    const final = await this.waitFor(success, req.stepTimeoutMs ?? 6000, outcomes);
    if (!final.ok) {
      const cond = detect(outcomes, final.obs);
      if (cond?.kind === 'business') return { ...base(), ...this.businessOutcome(cond, final.obs, 'success') } as ReplayResult;
      const bundle = await this.evidence.failureBundle(this.surface, 'success');
      return { ...base(), status: 'failed', failure: { code: 'SUCCESS_CONDITION_FAILED', message: 'all steps ran but the success condition did not hold', expected: describeCheckpoint(cap.success), observed: final.detail, evidence: bundle } };
    }
    const missing = Object.keys(cap.outputs).filter((k) => !(k in outputs));
    if (missing.length) return { ...base(), status: 'failed', failure: { code: 'OUTPUT_MISSING', message: `declared outputs not produced: ${missing.join(', ')}` } };
    this.evidence.log('replay.success', { outputs, drift: drift.length, recoveries: recoveries.length, interventions: interventions.length });
    return { ...base(), status: 'success', outputs };
  }

  // ---- helpers ----

  /** Poll for a checkpoint; stop early if a known condition shows up instead (no point waiting out the clock). */
  private async waitFor(cp: Capability['success'], timeoutMs: number, outcomes: OutcomeSpec[] = []): Promise<{ ok: boolean; detail: string; obs: Observation }> {
    const start = Date.now();
    let obs = await this.surface.observe();
    let r = evalCheckpoint(cp, obs);
    while (!r.ok && Date.now() - start < timeoutMs) {
      if (detect(outcomes, obs)) break;
      await new Promise((res) => setTimeout(res, 300));
      obs = await this.surface.observe();
      r = evalCheckpoint(cp, obs);
    }
    return { ...r, obs };
  }

  private businessOutcome(cond: OutcomeSpec, obs: Observation, atStep: string) {
    const message = captureMessage(cond, obs);
    this.evidence.log('replay.outcome', { code: cond.code, atStep, message });
    return { status: 'outcome' as const, outcome: { code: cond.code, message, description: cond.description, atStep } };
  }

  private async handleCondition(
    cond: OutcomeSpec,
    step: Step,
    obs: Observation,
    outcomes: OutcomeSpec[],
    reports: StepReport[],
    recoveries: RecoveryRecord[],
    i: number,
    restarts: number,
  ): Promise<{ result?: Partial<ReplayResult>; retry?: boolean; restart?: boolean }> {
    this.evidence.log('condition', { step: step.id, code: cond.code, kind: cond.kind, description: cond.description });
    if (cond.kind === 'business') return { result: this.businessOutcome(cond, obs, step.id) };
    if (cond.kind === 'hard') {
      const bundle = await this.evidence.failureBundle(this.surface, `${step.id}-${cond.code}`);
      return { result: { status: 'failed', failure: { code: cond.code, stepId: step.id, message: captureMessage(cond, obs) || cond.description, observed: summarize(obs), evidence: bundle } } };
    }
    // recoverable
    const rec = cond.recovery ?? { kind: 'escalate' as const, reason: cond.description };
    const already = recoveries.filter((r) => r.stepId === step.id && r.code === cond.code).length;
    if (already >= 2) {
      const bundle = await this.evidence.failureBundle(this.surface, `${step.id}-${cond.code}`);
      return { result: { status: 'failed', failure: { code: `${cond.code}_PERSISTS`, stepId: step.id, message: `recoverable condition ${cond.code} recurred after recovery`, evidence: bundle } } };
    }
    switch (rec.kind) {
      case 'dismiss': {
        const r = resolveTarget(rec.target, obs);
        if (!r) {
          recoveries.push({ stepId: step.id, code: cond.code, action: 'dismiss (control not found)', succeeded: false });
          break;
        }
        await this.surface.act({ kind: 'click', ref: r.element.ref });
        recoveries.push({ stepId: step.id, code: cond.code, action: `clicked ${rec.target.description}`, succeeded: true });
        this.evidence.log('recovery', { step: step.id, code: cond.code, action: 'dismiss', target: rec.target.description });
        return rec.then === 'continue' ? { retry: false } : { retry: true };
      }
      case 'reauth': {
        if (restarts >= 1) {
          return { result: { status: 'failed', failure: { code: 'SESSION_EXPIRED_PERSISTS', stepId: step.id, message: 'session expired again after re-authentication' } } };
        }
        recoveries.push({ stepId: step.id, code: cond.code, action: `re-authenticate via ${rec.capability} then restart`, succeeded: true });
        this.evidence.log('recovery', { step: step.id, code: cond.code, action: 'reauth+restart', via: rec.capability });
        for (const r of reports) if (r.status !== 'not_run') r.note = (r.note ? r.note + '; ' : '') + 'rerun after re-auth';
        return { restart: true };
      }
      case 'retry': {
        await new Promise((res) => setTimeout(res, rec.backoffMs));
        recoveries.push({ stepId: step.id, code: cond.code, action: `retry after ${rec.backoffMs}ms`, succeeded: true });
        return { retry: true };
      }
      case 'escalate':
        break;
    }
    const shot = await this.evidence.shot(this.surface, `${step.id}-${cond.code}`);
    const failure: Failure = { code: cond.code, stepId: step.id, message: cond.description, observed: summarize(obs), evidence: { screenshot: shot } };
    const decision = await this.escalate(step, i, obs, failure, this.lastInterventions, shot);
    if (decision === 'retry') return { retry: true };
    if (decision === 'skip') {
      reports[i].status = 'skipped_by_human';
      return { retry: false };
    }
    return { result: { status: 'escalated', failure } };
  }

  private lastInterventions: InterventionRecord[] = [];

  /** Bring a human in on the live session. Returns what automation should do next. */
  private async escalate(step: Step, index: number, obs: Observation, failure: Failure, interventions: InterventionRecord[], screenshot?: string): Promise<'retry' | 'skip' | 'abort'> {
    this.lastInterventions = interventions;
    const resolution = await this.control.requestIntervention({
      runId: this.evidence.runId,
      phase: 'replay',
      capability: undefined,
      goal: `replay step ${step.id}: ${step.description}`,
      stepIndex: index,
      stepId: step.id,
      reason: failure.message,
      cause: `${failure.code}: ${failure.message}`,
      url: obs.url,
      screenshot,
      observationSummary: summarize(obs),
      suggestedActions: suggest(failure, step),
    });
    const rec: InterventionRecord = { id: this.control.interventions[this.control.interventions.length - 1].id, stepId: step.id, cause: failure.code, operator: resolution.operator, action: resolution.action, note: resolution.note, humanActions: resolution.humanActions, takenAt: resolution.takenAt, resolvedAt: resolution.resolvedAt };
    interventions.push(rec);
    this.evidence.log('intervention.resolved', rec as any);
    if (resolution.action === 'resume') return 'retry';
    if (resolution.action === 'skip_step') return 'skip';
    return 'abort';
  }
}

// ---------- pure helpers ----------

export function applyOverrides(steps: Step[], override: TenantOverride | undefined, entryUrl: string, baseEntry: string): Step[] {
  return steps.map((s) => {
    let out: Step = { ...s };
    if (s.kind === 'navigate' && s.url === baseEntry) out = { ...out, url: entryUrl, expect: { all: [{ urlMatches: new URL(entryUrl).pathname }] } };
    if (entryUrl !== baseEntry) {
      // Same product mounted under a different prefix: move recorded route patterns to the tenant's prefix.
      if (out.target?.frame.urlPattern) out = { ...out, target: { ...out.target, frame: { ...out.target.frame, urlPattern: retarget(out.target.frame.urlPattern, baseEntry, entryUrl) } } };
      if (out.expect?.all) out = { ...out, expect: { ...out.expect, all: out.expect.all.map((c) => ('urlMatches' in c ? { urlMatches: retarget(c.urlMatches, baseEntry, entryUrl) } : c)) } };
    }
    const patch = override?.steps?.[s.id];
    if (patch) out = { ...out, ...(patch.target ? { target: patch.target } : {}), ...(patch.value ? { value: patch.value } : {}), ...(patch.expect ? { expect: patch.expect } : {}) };
    return out;
  });
}

function retarget(route: string, baseEntry: string, entryUrl: string): string {
  // /t/alpha/members -> /t/beta/members when the tenant entry differs only by a path prefix
  const a = new URL(baseEntry).pathname.split('/').slice(0, -1).join('/');
  const b = new URL(entryUrl).pathname.split('/').slice(0, -1).join('/');
  return a && route.startsWith(a) ? b + route.slice(a.length) : route;
}

export function detect(outcomes: OutcomeSpec[], obs: Observation): OutcomeSpec | null {
  for (const o of outcomes) if (evalCheckpoint(o.detect, obs).ok) return o;
  return null;
}

export function captureMessage(cond: OutcomeSpec, obs: Observation): string {
  if (cond.captureMessage) {
    const m = obs.text.match(new RegExp(cond.captureMessage, 'i'));
    if (m?.[1]) return m[1].replace(/\s+/g, ' ').trim();
  }
  return cond.description;
}

export function validateInputs(cap: Capability, inputs: Record<string, string>): string | null {
  for (const [name, spec] of Object.entries(cap.inputs)) {
    const v = inputs[name];
    if (v === undefined || v === '') {
      if (spec.required) return `missing required input "${name}"`;
      continue;
    }
    if (spec.pattern && !new RegExp(spec.pattern).test(v)) return `input "${name}" does not match ${spec.pattern}`;
    if (spec.type === 'number' && Number.isNaN(Number(v))) return `input "${name}" must be a number`;
    if (spec.enum && !spec.enum.includes(v)) return `input "${name}" must be one of ${spec.enum.join(', ')}`;
  }
  return null;
}

function toAction(step: Step, inputs: Record<string, string>, resolved: Resolved | null, profile: AppProfile): { action?: SurfaceAction } | { error: string } {
  switch (step.kind) {
    case 'navigate':
      return { action: { kind: 'navigate', url: step.url!.replace(/\{(\w+)\}/g, (_, k) => inputs[k] ?? '') } };
    case 'click':
      return { action: { kind: 'click', ref: resolved!.element.ref, acceptDialog: step.dialog?.respond === 'accept' } };
    case 'dismiss':
      return { action: { kind: 'click', ref: resolved!.element.ref } };
    case 'type':
    case 'select': {
      const v = step.value!;
      let text: string | undefined;
      if (v.kind === 'param') text = inputs[v.name];
      else if (v.kind === 'literal') text = v.value;
      else {
        text = process.env[v.ref];
        if (!text) return { error: `secret ${v.ref} is not configured in the environment` };
      }
      if (text === undefined) return { error: `no value for step ${step.id}` };
      return step.kind === 'type' ? { action: { kind: 'type', ref: resolved!.element.ref, text } } : { action: { kind: 'select', ref: resolved!.element.ref, option: text } };
    }
    case 'extract':
    case 'assert':
      return {};
  }
}

export function parseValue(raw: string, parse: Step['parse']): string | number | undefined {
  const s = raw.trim();
  if (parse === 'money') {
    const m = s.match(/^(-)?\$?\(?\s*([\d,]+(?:\.\d{1,2})?)\)?$/);
    if (!m) return undefined;
    const n = Number(m[2].replace(/,/g, ''));
    return m[1] || /^\(.*\)$/.test(s) ? -n : n;
  }
  if (parse === 'number') {
    const n = Number(s.replace(/,/g, ''));
    return Number.isNaN(n) ? undefined : n;
  }
  return s;
}

function summarize(obs: Observation): string {
  return `url=${obs.url}; frames=${obs.frames.map((f) => f.url).join(',')}; text="${obs.text.replace(/\s+/g, ' ').slice(0, 240)}"`;
}

function suggest(f: Failure, step: Step): string[] {
  if (f.code === 'TARGET_NOT_FOUND') return [`Locate ${step.target?.description ?? 'the control'} on screen and perform "${step.description}" manually, then hand back with skip_step`, 'If the screen is wrong, navigate to the expected screen and hand back with resume'];
  if (f.code === 'POLICY_BLOCKED') return ['Review the values on screen; if correct, perform the commit yourself and hand back with skip_step', 'Otherwise abort'];
  return ['Inspect the screen, fix the state, and hand back with resume', 'Abort if the run should not continue'];
}
