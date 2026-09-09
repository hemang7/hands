/**
 * Turning one tenant's replay evidence into overrides for that tenant (stretch: cross-tenant reuse).
 *
 * Two sources, both produced by a normal replay run:
 *   - drift warnings: a fallback strategy matched, so we know exactly which control it was; the
 *     TargetSpec rebuilt from that control becomes the tenant's primary target for the step
 *   - human handoffs: when an operator performed a step themselves (skip_step) and their recorded
 *     actions amount to a single click on a labelled control, that label becomes the override
 * The result is a *proposal*: it is written into a new draft version of the capability, and it
 * carries a note per step so a reviewer can see where each override came from.
 */
import type { Capability, TenantOverride } from './schema.js';
import type { ReplayResult } from '../replay/result.js';
import type { TargetSpec } from '../surface/types.js';

export interface OverrideProposal {
  tenant: string;
  override: TenantOverride;
  notes: string[];
}

export function proposeOverrides(cap: Capability, result: ReplayResult): OverrideProposal {
  const steps: NonNullable<TenantOverride['steps']> = {};
  const notes: string[] = [];
  for (const d of result.drift) {
    if (!d.matchedTarget) continue;
    steps[d.stepId] = { target: d.matchedTarget };
    notes.push(`${d.stepId}: primary "${d.primary}" failed on ${result.tenant}; using the control matched via "${d.used}" (${d.matchedTarget.description}) as this tenant's target`);
  }
  for (const iv of result.interventions) {
    if (iv.action !== 'skip_step') continue;
    const clicks = iv.humanActions.filter((a) => a.kind === 'click');
    const step = cap.steps.find((s) => s.id === iv.stepId);
    if (clicks.length !== 1 || !step?.target) {
      notes.push(`${iv.stepId}: operator ${iv.operator} performed this step by hand (${iv.humanActions.length} actions); no unambiguous override could be derived, author one manually`);
      continue;
    }
    const m = clicks[0].target.match(/^(\w+)(?:\[type=(\w+)\])? "(.*)"$/);
    if (!m) continue;
    const [, tag, type, label] = m;
    const role = tag === 'a' ? 'link' : 'button';
    const target: TargetSpec = {
      description: `the "${label}" ${role} (from operator ${iv.operator}'s action)`,
      frame: {},
      strategies: [{ kind: 'role', role, name: label }],
      fingerprint: { tag, role, name: label, type },
    };
    steps[iv.stepId] = { target };
    notes.push(`${iv.stepId}: operator ${iv.operator} clicked ${tag} "${label}" during handoff ("${iv.note}"); proposing role=${role} name="${label}"`);
  }
  return { tenant: result.tenant, override: { steps, notes: notes.join('\n') }, notes };
}

/** New draft version carrying the tenant override; the original version is untouched. */
export function withOverride(cap: Capability, proposal: OverrideProposal): Capability {
  return {
    ...cap,
    version: cap.version + 1,
    status: 'draft',
    tenants: { ...(cap.tenants ?? {}), [proposal.tenant]: proposal.override },
    provenance: { ...cap.provenance, recordedBy: 'derived', recordedAt: new Date().toISOString() },
  };
}
