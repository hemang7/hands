/**
 * Replay result contract: what the calling agent gets back.
 *
 * Four top-level statuses, deliberately not collapsed into "ok / error":
 *   success   - goal met, outputs validated against the declared contract
 *   outcome   - a declared *business* outcome (RECORD_NOT_FOUND, PERMISSION_DENIED...): a legitimate
 *               answer, carried with the app's own message, never treated as a failure
 *   failed    - a hard failure with enough to debug: step, what was expected, what was observed,
 *               a screenshot and a DOM snapshot
 *   escalated - a human was brought in and chose to abort (or none answered in time)
 * Recoverable conditions never surface as a status; they appear in `recoveries` so the caller and
 * the reviewer can see what the engine had to do to get the answer.
 */
import type { HumanEvent, TargetSpec } from '../surface/types.js';

export interface StepReport {
  id: string;
  kind: string;
  status: 'ok' | 'recovered' | 'skipped_by_human' | 'failed' | 'not_run';
  attempts: number;
  strategyUsed?: string; // e.g. "anchor" or "css (fallback #4)"
  fingerprintScore?: number;
  durationMs: number;
  note?: string;
}

export interface DriftWarning {
  stepId: string;
  primary: string;
  used: string;
  strategyIndex: number;
  message: string;
  /** A fresh TargetSpec built from the control as it looked on this run: the raw material for a tenant override. */
  matchedTarget?: TargetSpec;
}

export interface RecoveryRecord {
  stepId: string;
  code: string;
  action: string;
  succeeded: boolean;
}

export interface InterventionRecord {
  id: string;
  stepId: string;
  cause: string;
  operator: string;
  action: 'resume' | 'skip_step' | 'abort';
  note: string;
  humanActions: HumanEvent[];
  takenAt?: string;
  resolvedAt: string;
}

export interface Failure {
  code: string; // TARGET_NOT_FOUND | CHECKPOINT_FAILED | APP_ERROR | TIMEOUT | POLICY_BLOCKED | INVALID_INPUT | OUTPUT_MISSING | SUCCESS_CONDITION_FAILED | ...
  stepId?: string;
  message: string;
  expected?: string;
  observed?: string;
  evidence?: { screenshot?: string; snapshot?: string };
}

interface Base {
  runId: string;
  capability: { id: string; version: number; status: string };
  tenant: string;
  inputs: Record<string, string>; // pii-masked in logs by the redactor; full here
  startedAt: string;
  durationMs: number;
  steps: StepReport[];
  drift: DriftWarning[];
  recoveries: RecoveryRecord[];
  interventions: InterventionRecord[];
  evidenceDir: string;
}

export type ReplayResult =
  | (Base & { status: 'success'; outputs: Record<string, string | number | boolean> })
  | (Base & { status: 'outcome'; outcome: { code: string; message: string; description: string; atStep: string } })
  | (Base & { status: 'failed'; failure: Failure })
  | (Base & { status: 'escalated'; failure: Failure });

/** Exit code mapping for the CLI: business outcomes are 0 (they are answers), failures are not. */
export function exitCodeFor(r: ReplayResult): number {
  return r.status === 'success' || r.status === 'outcome' ? 0 : r.status === 'escalated' ? 3 : 2;
}
