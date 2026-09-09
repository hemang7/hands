/**
 * Capability artifact schema (v1).
 *
 * A Capability is the unit an AI agent calls in production. It is a *contract* first and a step
 * list second: typed inputs, typed outputs, the business outcomes the caller must be prepared for,
 * the risk class of what it does, and only then the recorded steps that achieve it.
 *
 * Shaping decisions, each defended in REPORT.md:
 *  - inputs/outputs are declared with JSON-schema-like specs so a catalog can turn a capability
 *    straight into a function-calling tool definition without any extra metadata
 *  - outcomes live in three kinds (business / recoverable / hard) and carry their own detectors and
 *    recoveries; the replay engine owns the taxonomy, the artifact owns the vocabulary
 *  - app-level conditions (session expiry, interstitials, app errors) live in an AppProfile shared
 *    by every capability and every tenant of that vendor product, not copied into each artifact
 *  - a step's value is a reference ({param}/{literal}/{secret}), never a raw value that was typed,
 *    so nothing sensitive is serialized and every invocation is parameterized by construction
 *  - tenant overrides are sparse patches keyed by step id, so one recording serves N institutions
 */
import { z } from 'zod';

// ---------- targeting (mirrors surface/types.ts, validated here) ----------
export const RoleZ = z.enum(['button', 'link', 'textbox', 'password', 'combobox', 'checkbox', 'radio', 'cell', 'heading', 'text', 'option', 'other']);

export const LocatorStrategyZ = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('role'), role: RoleZ, name: z.string() }),
  z.object({ kind: z.literal('anchor'), anchor: z.string(), role: RoleZ }),
  z.object({ kind: z.literal('text'), text: z.string(), role: RoleZ.optional() }),
  z.object({ kind: z.literal('grid'), row: z.string(), column: z.string() }),
  z.object({ kind: z.literal('attr'), tag: z.string(), name: z.string().optional(), type: z.string().optional(), value: z.string().optional() }),
  z.object({ kind: z.literal('css'), selector: z.string() }),
]);

export const TargetSpecZ = z.object({
  description: z.string(),
  frame: z.object({ name: z.string().optional(), urlPattern: z.string().optional() }),
  strategies: z.array(LocatorStrategyZ).min(1),
  fingerprint: z.object({
    tag: z.string(),
    role: RoleZ,
    name: z.string(),
    attrName: z.string().optional(),
    type: z.string().optional(),
    anchor: z.string().optional(),
  }),
});

// ---------- conditions: used for checkpoints and outcome detectors ----------
export const ConditionZ = z.union([
  z.object({ urlMatches: z.string() }), // pattern with :id placeholders, matched against top url or any frame url
  z.object({ textPresent: z.string() }), // case-insensitive substring of visible text
  z.object({ textMatches: z.string() }), // regex over visible text
  z.object({ textAbsent: z.string() }),
  z.object({ elementPresent: z.object({ role: RoleZ, name: z.string() }) }),
  z.object({ dialogSeen: z.string() }), // regex over dialog messages since last observation
]);
export const CheckpointZ = z.object({
  all: z.array(ConditionZ).optional(),
  any: z.array(ConditionZ).optional(),
});

// ---------- contract: inputs / outputs ----------
export const ParamSpecZ = z.object({
  type: z.enum(['string', 'number', 'money', 'enum', 'boolean']),
  description: z.string(),
  required: z.boolean().default(true),
  pattern: z.string().optional(),
  enum: z.array(z.string()).optional(),
  /** Drives redaction: pii is masked in logs, secret is never stored or shown to the model. */
  sensitivity: z.enum(['none', 'pii', 'secret']).default('none'),
  example: z.string().optional(),
});
export const OutputSpecZ = z.object({
  type: z.enum(['string', 'number', 'money', 'boolean']),
  description: z.string(),
  sensitivity: z.enum(['none', 'pii']).default('none'),
  /** id of the extract step that produces it */
  fromStep: z.string(),
});

// ---------- outcomes ----------
export const RecoveryZ = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dismiss'), target: TargetSpecZ, then: z.enum(['retry_step', 'continue']).default('retry_step') }),
  z.object({ kind: z.literal('reauth'), capability: z.string(), then: z.enum(['restart', 'retry_step']).default('restart') }),
  z.object({ kind: z.literal('retry'), maxAttempts: z.number().int().min(1).max(5), backoffMs: z.number().int().min(0) }),
  z.object({ kind: z.literal('escalate'), reason: z.string() }),
]);

export const OutcomeSpecZ = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
  /**
   * business    - a legitimate answer the caller needs (NOT an error): "no such member"
   * recoverable - a transient/interstitial condition the engine can clear and continue
   * hard        - stop, surface a debuggable failure
   */
  kind: z.enum(['business', 'recoverable', 'hard']),
  description: z.string(),
  detect: CheckpointZ,
  recovery: RecoveryZ.optional(),
  /** For business outcomes: capture the message shown so the caller sees the app's own words. */
  captureMessage: z.string().optional(), // regex with one capture group
});

// ---------- steps ----------
export const ValueRefZ = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('param'), name: z.string() }),
  z.object({ kind: z.literal('literal'), value: z.string() }),
  z.object({ kind: z.literal('secret'), ref: z.string() }), // env var name, resolved at runtime, never serialized
]);

export const RiskZ = z.enum(['safe', 'reversible', 'irreversible']);

export const StepZ = z.object({
  id: z.string(),
  kind: z.enum(['navigate', 'click', 'type', 'select', 'extract', 'assert', 'dismiss']),
  /** Why this step exists and why this target was chosen. Written for the human reviewer. */
  description: z.string(),
  target: TargetSpecZ.optional(),
  url: z.string().optional(), // navigate: may contain {param} placeholders
  value: ValueRefZ.optional(), // type/select
  output: z.string().optional(), // extract: output name
  parse: z.enum(['text', 'money', 'number']).optional(),
  /** Post-condition verified after the action. Missing = no wait beyond surface quiescence. */
  expect: CheckpointZ.optional(),
  /** A native dialog that legitimately appears on this step and how it must be answered. */
  dialog: z.object({ expect: z.enum(['confirm', 'alert', 'prompt']), respond: z.enum(['accept', 'dismiss']) }).optional(),
  risk: RiskZ,
  timeoutMs: z.number().int().positive().optional(),
});

// ---------- policy ----------
export const PolicyZ = z.object({
  allowlist: z.object({
    origins: z.array(z.string()).min(1),
    routes: z.array(z.string()), // path patterns; empty = any path under an allowed origin
    actions: z.array(z.enum(['navigate', 'click', 'type', 'select', 'extract', 'assert', 'dismiss'])),
  }),
  /** Highest risk class in this capability; irreversible requires an approved artifact + caller confirmation. */
  maxRisk: RiskZ,
});

// ---------- tenant overrides ----------
export const TenantOverrideZ = z.object({
  entryUrl: z.string().optional(),
  /** Sparse patch per step id: replace the target and/or value. */
  steps: z.record(z.string(), z.object({ target: TargetSpecZ.optional(), value: ValueRefZ.optional(), expect: CheckpointZ.optional() })).optional(),
  /** Extra outcomes (e.g. a tenant-specific interstitial) merged in front of the base list. */
  outcomes: z.array(OutcomeSpecZ).optional(),
  notes: z.string().optional(),
});

// ---------- the capability ----------
export const CapabilityZ = z.object({
  schemaVersion: z.literal('1.0'),
  id: z.string().regex(/^[a-z][a-z0-9_]+$/),
  version: z.number().int().positive(),
  status: z.enum(['draft', 'approved', 'deprecated']),
  name: z.string(),
  description: z.string(),
  app: z.object({
    profile: z.string(), // AppProfile id (vendor product), e.g. "legacycore-teller"
    surface: z.enum(['web', 'desktop']),
    entryUrl: z.string(),
  }),
  inputs: z.record(z.string(), ParamSpecZ),
  outputs: z.record(z.string(), OutputSpecZ),
  outcomes: z.array(OutcomeSpecZ),
  steps: z.array(StepZ).min(1),
  success: CheckpointZ,
  policy: PolicyZ,
  provenance: z.object({
    recordedAt: z.string(),
    recordedBy: z.enum(['discovery', 'human', 'derived']),
    model: z.string().optional(),
    discoveryRunId: z.string().optional(),
    goal: z.string().optional(),
    tenant: z.string().optional(),
    /** Number of human interventions during recording. >0 means the step list may not be complete. */
    humanInterventions: z.number().int().optional(),
  }),
  tenants: z.record(z.string(), TenantOverrideZ).optional(),
  stats: z.object({ replays: z.number().int(), successes: z.number().int(), lastReplayAt: z.string().optional() }).optional(),
});

export type Capability = z.infer<typeof CapabilityZ>;
export type Step = z.infer<typeof StepZ>;
export type Checkpoint = z.infer<typeof CheckpointZ>;
export type Condition = z.infer<typeof ConditionZ>;
export type OutcomeSpec = z.infer<typeof OutcomeSpecZ>;
export type Recovery = z.infer<typeof RecoveryZ>;
export type ValueRef = z.infer<typeof ValueRefZ>;
export type ParamSpec = z.infer<typeof ParamSpecZ>;
export type OutputSpec = z.infer<typeof OutputSpecZ>;
export type Policy = z.infer<typeof PolicyZ>;
export type Risk = z.infer<typeof RiskZ>;
export type TenantOverride = z.infer<typeof TenantOverrideZ>;

// ---------- app profile: per vendor product, shared across capabilities and tenants ----------
export const AppProfileZ = z.object({
  id: z.string(),
  vendor: z.string(),
  product: z.string(),
  description: z.string(),
  /** Conditions every capability on this product must survive. Checked before every step. */
  conditions: z.array(OutcomeSpecZ),
  /** Where secrets come from for this product's login; values are env var names. */
  secrets: z.record(z.string(), z.string()).default({}),
  /** Risk classification hints: button/link names that mean "commit" on this product. */
  irreversibleControlPattern: z.string().optional(),
  tenants: z.record(z.string(), z.object({ label: z.string(), entryUrl: z.string(), notes: z.string().optional() })),
});
export type AppProfile = z.infer<typeof AppProfileZ>;

export function validateCapability(raw: unknown): Capability {
  const cap = CapabilityZ.parse(raw);
  // cross-field checks the type system can't express
  const stepIds = new Set(cap.steps.map((s) => s.id));
  for (const [name, o] of Object.entries(cap.outputs)) {
    if (!stepIds.has(o.fromStep)) throw new Error(`output "${name}" references unknown step "${o.fromStep}"`);
  }
  for (const s of cap.steps) {
    if (s.value?.kind === 'param' && !cap.inputs[s.value.name]) throw new Error(`step "${s.id}" references unknown input "${s.value.name}"`);
    if ((s.kind === 'type' || s.kind === 'select') && !s.value) throw new Error(`step "${s.id}" needs a value`);
    if (s.kind !== 'navigate' && s.kind !== 'assert' && !s.target) throw new Error(`step "${s.id}" needs a target`);
    if (s.kind === 'extract' && !s.output) throw new Error(`extract step "${s.id}" needs an output name`);
  }
  const maxRisk = cap.steps.reduce<Risk>((m, s) => (rank(s.risk) > rank(m) ? s.risk : m), 'safe');
  if (rank(maxRisk) > rank(cap.policy.maxRisk)) throw new Error(`policy.maxRisk (${cap.policy.maxRisk}) is below a step's risk (${maxRisk})`);
  return cap;
}

export function rank(r: Risk): number {
  return r === 'safe' ? 0 : r === 'reversible' ? 1 : 2;
}
