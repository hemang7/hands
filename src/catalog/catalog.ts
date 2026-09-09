/**
 * Agent-facing capability catalog (stretch goal).
 *
 * Every saved artifact becomes a callable tool: the capability's declared inputs are the tool's
 * JSON-schema parameters, its outputs/outcomes are documented in the description, and invoking it
 * runs the deterministic replay engine. The calling agent never sees a browser; it sees a function
 * that returns {status, outputs | outcome | failure}.
 */
import path from 'node:path';
import type { Capability } from '../artifact/schema.js';
import type { CapabilityStore } from '../artifact/store.js';
import { Evidence, newRunId } from '../evidence/evidence.js';
import { SessionController } from '../handoff/control.js';
import { ConsoleOperator } from '../handoff/operators.js';
import { Redactor } from '../policy/redact.js';
import { ReplayEngine } from '../replay/engine.js';
import type { ReplayResult } from '../replay/result.js';
import { PlaywrightSurface } from '../surface/playwright.js';

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface InvokeOptions {
  tenant?: string;
  confirm?: boolean;
  headed?: boolean;
  runsDir?: string;
  /** Allow draft capabilities to be invoked (default: approved only, like production would). */
  includeDrafts?: boolean;
}

export interface InvokeResult {
  status: ReplayResult['status'];
  runId: string;
  outputs?: Record<string, unknown>;
  outcome?: { code: string; message: string };
  failure?: { code: string; message: string; stepId?: string };
  driftWarnings: number;
  recoveries: number;
  interventions: number;
}

export class Catalog {
  constructor(private store: CapabilityStore) {}

  /** Latest version per id. */
  capabilities(includeDrafts = true): Capability[] {
    const latest = new Map<string, Capability>();
    for (const c of this.store.list()) latest.set(c.id, c);
    return [...latest.values()].filter((c) => c.status !== 'deprecated' && (includeDrafts || c.status === 'approved'));
  }

  tools(includeDrafts = true): ToolDefinition[] {
    return this.capabilities(includeDrafts).map((c) => ({
      type: 'function',
      function: {
        name: c.id,
        description: describeForAgent(c),
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(c.inputs).map(([k, p]) => [k, { type: p.type === 'number' || p.type === 'money' ? 'number' : 'string', description: p.description + (p.pattern ? ` (pattern ${p.pattern})` : ''), ...(p.enum ? { enum: p.enum } : {}) }]),
          ),
          required: Object.entries(c.inputs)
            .filter(([, p]) => p.required)
            .map(([k]) => k),
        },
      },
    }));
  }

  describe(): string[] {
    return this.capabilities().map((c) => {
      const ins = Object.entries(c.inputs).map(([k, p]) => `${k}: ${p.type}${p.sensitivity !== 'none' ? ` [${p.sensitivity}]` : ''}`).join(', ');
      const outs = Object.entries(c.outputs).map(([k, o]) => `${k}: ${o.type}`).join(', ');
      const outcomes = c.outcomes.map((o) => o.code).join(', ') || '(app profile only)';
      return `${c.id} v${c.version} [${c.status}] risk=${c.policy.maxRisk}\n  ${c.name}: ${c.description}\n  inputs:   ${ins || '-'}\n  outputs:  ${outs || '-'}\n  outcomes: ${outcomes}\n  steps:    ${c.steps.length}  tenants: ${Object.keys(c.tenants ?? {}).join(', ') || c.provenance.tenant}`;
    });
  }

  async invoke(name: string, args: Record<string, unknown>, opts: InvokeOptions = {}): Promise<InvokeResult> {
    const cap = this.capabilities(opts.includeDrafts ?? true).find((c) => c.id === name);
    if (!cap) throw new Error(`unknown capability "${name}"`);
    const inputs: Record<string, string> = {};
    for (const [k, val] of Object.entries(args)) inputs[k] = String(val);
    const profile = this.store.loadProfile(cap.app.profile);
    const redactor = new Redactor();
    for (const env of Object.values(profile.secrets)) redactor.addSecret(process.env[env]);
    const evidence = new Evidence(newRunId(`invoke-${cap.id}`), redactor, path.resolve(opts.runsDir ?? 'runs'), false);
    const surface = await PlaywrightSurface.launch({ headless: !opts.headed });
    const control = new SessionController(surface, [new ConsoleOperator()], 60_000);
    try {
      const r = await new ReplayEngine(surface, this.store, evidence, control, redactor).run({ capability: cap, inputs, tenant: opts.tenant, confirm: opts.confirm });
      evidence.writeJson('result.json', r);
      const out: InvokeResult = { status: r.status, runId: r.runId, driftWarnings: r.drift.length, recoveries: r.recoveries.length, interventions: r.interventions.length };
      if (r.status === 'success') out.outputs = r.outputs;
      if (r.status === 'outcome') out.outcome = { code: r.outcome.code, message: r.outcome.message };
      if (r.status === 'failed' || r.status === 'escalated') out.failure = { code: r.failure.code, message: r.failure.message, stepId: r.failure.stepId };
      return out;
    } finally {
      evidence.close();
      await surface.close();
    }
  }
}

function describeForAgent(c: Capability): string {
  const outs = Object.entries(c.outputs).map(([k, o]) => `${k} (${o.type}): ${o.description}`).join('; ');
  const outcomes = c.outcomes.map((o) => `${o.code}: ${o.description}`).join('; ');
  return `${c.description} Returns: ${outs || 'no outputs'}. Possible business outcomes (not errors): ${outcomes || 'see app profile'}. Risk: ${c.policy.maxRisk}. Status: ${c.status}.`;
}
