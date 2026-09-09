/**
 * End-to-end against the real hostile target app, in-process, with the scripted decider standing
 * in for the model. Covers: discovery -> artifact -> replay (success, business outcome, recovery,
 * cross-tenant drift + human handoff -> learned overrides -> clean replay).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../target-app/server.js';
import { CapabilityStore } from '../src/artifact/store.js';
import { DiscoveryAgent } from '../src/discovery/agent.js';
import { memberLookupScript } from '../src/discovery/scripted.js';
import { Evidence } from '../src/evidence/evidence.js';
import { SessionController } from '../src/handoff/control.js';
import { ScriptedOperator } from '../src/handoff/operators.js';
import { SCENARIOS } from '../src/handoff/scenarios.js';
import { PolicyEngine } from '../src/policy/policy.js';
import { Redactor } from '../src/policy/redact.js';
import { ReplayEngine } from '../src/replay/engine.js';
import { PlaywrightSurface } from '../src/surface/playwright.js';
import { proposeOverrides, withOverride } from '../src/artifact/overrides.js';
import type { Capability } from '../src/artifact/schema.js';

let server: Server;
let base: string;
let tmp: string;
let store: CapabilityStore;
const secrets = { LEGACYCORE_USER: 'teller1', LEGACYCORE_PASSWORD: 'teller1-pass' };

beforeAll(async () => {
  Object.assign(process.env, secrets);
  await new Promise<void>((r) => (server = createApp().listen(0, r)));
  base = `http://localhost:${(server.address() as any).port}`;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hands-'));
  fs.mkdirSync(path.join(tmp, 'apps'));
  const profile = fs.readFileSync('apps/legacycore-teller.json', 'utf8').replaceAll('http://localhost:4010', base);
  fs.writeFileSync(path.join(tmp, 'apps', 'legacycore-teller.json'), profile);
  store = new CapabilityStore(path.join(tmp, 'capabilities'), path.join(tmp, 'apps'));
});
afterAll(async () => {
  server?.close();
});

async function session(operator?: keyof typeof SCENARIOS) {
  const surface = await PlaywrightSurface.launch({ settleTimeoutMs: 4000 });
  const redactor = new Redactor();
  Object.values(secrets).forEach((s) => redactor.addSecret(s));
  const control = new SessionController(surface, [], 4000);
  if (operator) control.addOperator(new ScriptedOperator(surface.page, SCENARIOS[operator], 'jane'));
  const evidence = new Evidence(`t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, redactor, path.join(tmp, 'runs'), false);
  return { surface, redactor, control, evidence, close: async () => (evidence.close(), surface.close()) };
}

async function replay(cap: Capability, inputs: Record<string, string>, opts: { tenant?: string; operator?: keyof typeof SCENARIOS; chaos?: string } = {}) {
  if (opts.chaos) await fetch(`${base}/__chaos?tenant=${opts.tenant ?? 'alpha'}&set=${opts.chaos}`);
  const s = await session(opts.operator);
  try {
    return await new ReplayEngine(s.surface, store, s.evidence, s.control, s.redactor).run({ capability: cap, inputs, tenant: opts.tenant });
  } finally {
    await s.close();
  }
}

describe('end to end on the hostile target app', () => {
  let cap: Capability;

  it('discovers a capability with the scripted decider and records a typed artifact', async () => {
    const s = await session();
    try {
      const profile = store.loadProfile('legacycore-teller');
      const policy = new PolicyEngine({ allowlist: { origins: [base], routes: [], actions: ['navigate', 'click', 'type', 'select', 'extract'] }, irreversibleControlPattern: profile.irreversibleControlPattern });
      const agent = new DiscoveryAgent(s.surface, memberLookupScript('10001'), policy, s.evidence, s.control);
      const r = await agent.run({
        capabilityId: 'lookup_member_balance',
        goal: { goal: 'Look up member {memberId} and read the share savings balance', inputs: { memberId: { value: '10001', sensitivity: 'pii' } }, secretRefs: ['username', 'password'], allowIrreversible: false },
        entryUrl: profile.tenants.alpha.entryUrl,
        profile,
        tenant: 'alpha',
        maxSteps: 15,
      });
      expect(r.status).toBe('success');
      if (r.status !== 'success') return;
      cap = r.capability;
      store.save(cap);
      expect(cap.steps.map((x) => x.kind)).toEqual(['navigate', 'type', 'type', 'click', 'click', 'type', 'click', 'extract']);
      expect(cap.steps[1].value).toEqual({ kind: 'secret', ref: 'LEGACYCORE_USER' });
      expect(cap.steps[5].value).toEqual({ kind: 'param', name: 'memberId' });
      expect(cap.outputs.savings_balance.type).toBe('money');
      expect(JSON.stringify(cap)).not.toMatch(/teller1|10001/);
      expect(fs.existsSync(path.join(s.evidence.dir, 'run.jsonl'))).toBe(true);
    } finally {
      await s.close();
    }
  }, 60_000);

  it('replays deterministically with a different input and returns typed outputs', async () => {
    const r = await replay(cap, { memberId: '10003' });
    expect(r.status).toBe('success');
    if (r.status === 'success') expect(r.outputs).toEqual({ savings_balance: 15987.12 });
    expect(r.drift).toEqual([]);
  }, 60_000);

  it('reports a business outcome (not a failure) for an unknown member', async () => {
    const r = await replay(cap, { memberId: '99999' });
    expect(r.status).toBe('outcome');
    if (r.status === 'outcome') expect(r.outcome).toMatchObject({ code: 'RECORD_NOT_FOUND', atStep: 's6_click' });
  }, 60_000);

  it('fails fast on an input that violates the contract', async () => {
    const r = await replay(cap, { memberId: 'abc' });
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.failure.code).toBe('INVALID_INPUT');
    expect(r.steps.every((s) => s.status === 'not_run')).toBe(true);
  });

  it('recovers from a session expiry by re-authenticating and restarting', async () => {
    const r = await replay(cap, { memberId: '10001' }, { chaos: 'timeout' });
    expect(r.status).toBe('success');
    expect(r.recoveries.map((x) => x.code)).toEqual(['SESSION_EXPIRED']);
  }, 60_000);

  it('surfaces an application error as a hard failure with a failure bundle', async () => {
    const r = await replay(cap, { memberId: '10001' }, { chaos: 'crash' });
    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.failure.code).toBe('APP_ERROR');
      expect(r.failure.evidence?.screenshot).toMatch(/\.png$/);
      expect(r.failure.evidence?.snapshot).toMatch(/\.html$/);
    }
  }, 60_000);

  it('runs on a second tenant with drift warnings and a human handoff, then learns overrides for a clean replay', async () => {
    const r1 = await replay(cap, { memberId: '10001' }, { tenant: 'beta', operator: 'tenant-beta-operator' });
    expect(r1.status).toBe('success');
    expect(r1.drift.length).toBeGreaterThanOrEqual(5);
    expect(r1.interventions).toHaveLength(1);
    expect(r1.interventions[0]).toMatchObject({ stepId: 's4_click', action: 'skip_step', operator: 'jane' });
    expect(r1.interventions[0].humanActions.some((a) => a.kind === 'click' && /Customer Lookup/.test(a.target))).toBe(true);
    expect(r1.recoveries.map((x) => x.code)).toContain('SYSTEM_NOTICE');

    const proposal = proposeOverrides(cap, r1);
    expect(Object.keys(proposal.override.steps ?? {})).toContain('s4_click');
    const v2 = withOverride(cap, proposal);
    expect(v2.version).toBe(2);

    const r2 = await replay(v2, { memberId: '10002' }, { tenant: 'beta' });
    expect(r2.status).toBe('success');
    expect(r2.drift).toEqual([]);
    expect(r2.interventions).toEqual([]);
    if (r2.status === 'success') expect(r2.outputs).toEqual({ savings_balance: 250 });

    const r3 = await replay(v2, { memberId: '10001' });
    expect(r3.status).toBe('success'); // overrides for beta leave alpha untouched
  }, 120_000);

  it('escalates when no strategy can locate a control and the operator aborts', async () => {
    const broken: Capability = { ...cap, steps: cap.steps.map((s) => (s.id === 's4_click' ? { ...s, target: { ...s.target!, strategies: [{ kind: 'role', role: 'link', name: 'Does Not Exist' }] } } : s)) };
    const r = await replay(broken, { memberId: '10001' }, { operator: 'abort' });
    expect(r.status).toBe('escalated');
    if (r.status === 'escalated') expect(r.failure.code).toBe('TARGET_NOT_FOUND');
    expect(r.interventions[0].action).toBe('abort');
  }, 60_000);
});
