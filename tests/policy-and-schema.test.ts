import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { PolicyEngine } from '../src/policy/policy.js';
import { Redactor } from '../src/policy/redact.js';
import { AppProfileZ, validateCapability } from '../src/artifact/schema.js';
import { evalCheckpoint } from '../src/artifact/conditions.js';
import { detect, parseValue, validateInputs, applyOverrides } from '../src/replay/engine.js';
import type { ObservedElement, Observation } from '../src/surface/types.js';

const btn = (name: string): ObservedElement => ({ ref: 1, frame: 'main', role: 'button', name, text: '', tag: 'input', attrs: { type: 'submit', value: name }, cssPath: 'x', bbox: { x: 0, y: 0, w: 1, h: 1 }, enabled: true, editable: false });
const link = (href: string): ObservedElement => ({ ...btn('go'), role: 'link', tag: 'a', attrs: { href } });

describe('PolicyEngine', () => {
  const p = new PolicyEngine({ allowlist: { origins: ['http://localhost:4010'], routes: ['/t/alpha/*'], actions: ['navigate', 'click', 'type', 'extract'] }, irreversibleControlPattern: '^(confirm|post)$' });

  it('enforces origin and route allowlists on navigation and on links', () => {
    expect(p.authorize({ kind: 'navigate', url: 'http://localhost:4010/t/alpha/login' }, { phase: 'replay' }).allowed).toBe(true);
    expect(p.authorize({ kind: 'navigate', url: 'http://evil.example/t/alpha/login' }, { phase: 'replay' }).allowed).toBe(false);
    expect(p.authorize({ kind: 'navigate', url: 'http://localhost:4010/t/beta/login' }, { phase: 'replay' }).reason).toMatch(/route/);
    expect(p.authorize({ kind: 'click', ref: 1 }, { phase: 'replay' }, link('https://evil.example/x'), 'http://localhost:4010/t/alpha/home').allowed).toBe(false);
  });
  it('blocks action kinds outside the allowlist', () => {
    expect(p.authorize({ kind: 'press', key: 'Enter' }, { phase: 'replay' }).allowed).toBe(false);
  });
  it('classifies risk: typing is safe, a submit is reversible, Confirm or accepting a dialog is irreversible', () => {
    expect(p.classify({ kind: 'type', ref: 1, text: 'x' })).toBe('safe');
    expect(p.classify({ kind: 'click', ref: 1 }, btn('Inquire'))).toBe('reversible');
    expect(p.classify({ kind: 'click', ref: 1 }, btn('Confirm'))).toBe('irreversible');
    expect(p.classify({ kind: 'click', ref: 1, acceptDialog: true }, btn('Inquire'))).toBe('irreversible');
  });
  it('requires two consents for irreversible actions in discovery and approval + confirm in replay', () => {
    const confirm = { kind: 'click' as const, ref: 1 };
    expect(p.authorize(confirm, { phase: 'discovery' }, btn('Confirm')).allowed).toBe(false);
    expect(p.authorize(confirm, { phase: 'discovery', allowIrreversible: true }, btn('Confirm')).allowed).toBe(false);
    expect(p.authorize(confirm, { phase: 'discovery', allowIrreversible: true, modelAcknowledged: true }, btn('Confirm')).allowed).toBe(true);
    expect(p.authorize(confirm, { phase: 'replay', callerConfirmed: true }, btn('Confirm')).reason).toMatch(/not approved/);
    expect(p.authorize(confirm, { phase: 'replay', artifactApproved: true }, btn('Confirm')).reason).toMatch(/confirm=true/);
    expect(p.authorize(confirm, { phase: 'replay', artifactApproved: true, callerConfirmed: true }, btn('Confirm')).allowed).toBe(true);
  });
});

describe('Redactor', () => {
  it('masks secrets (longest first), pii values and regulated identifiers everywhere', () => {
    const r = new Redactor();
    r.addSecret('teller1');
    r.addSecret('teller1-pass');
    r.addPii('10001');
    expect(r.scrub('typed teller1-pass for teller1 member 10001 ssn 123-45-6789 card 4111 1111 1111 1111')).toBe('typed [secret] for [secret] member •••01 ssn [ssn] card [pan]');
    expect(r.scrubDeep({ a: ['10001'], b: { c: 'teller1' } })).toEqual({ a: ['•••01'], b: { c: '[secret]' } });
  });
});

describe('Capability schema', () => {
  const cap = JSON.parse(fs.readFileSync('tests/fixtures/lookup_member_balance.json', 'utf8'));
  it('accepts the recorded example and rejects dangling references', () => {
    expect(validateCapability(cap).id).toBe('lookup_member_balance');
    expect(() => validateCapability({ ...cap, outputs: { x: { type: 'money', description: '', fromStep: 'nope' } } })).toThrow(/unknown step/);
    expect(() => validateCapability({ ...cap, steps: cap.steps.map((s: any) => (s.id === 's5_type' ? { ...s, value: { kind: 'param', name: 'ghost' } } : s)) })).toThrow(/unknown input/);
    expect(() => validateCapability({ ...cap, policy: { ...cap.policy, maxRisk: 'safe' } })).toThrow(/maxRisk/);
  });
  it('never contains secret or pii values', () => {
    const text = JSON.stringify(cap);
    expect(text).not.toMatch(/teller1|10001/);
    expect(text).toMatch(/"kind": ?"secret"/);
  });
  it('validates inputs against the contract before touching a surface', () => {
    expect(validateInputs(cap, {})).toMatch(/missing/);
    expect(validateInputs(cap, { memberId: '12' })).toMatch(/does not match/);
    expect(validateInputs(cap, { memberId: '10003' })).toBeNull();
  });
  it('loads the app profile', () => {
    const p = AppProfileZ.parse(JSON.parse(fs.readFileSync('apps/legacycore-teller.json', 'utf8')));
    expect(p.conditions.map((c) => c.kind)).toContain('business');
  });
  it('applies tenant overrides sparsely and retargets recorded routes', () => {
    const steps = applyOverrides(cap.steps, { steps: { s4_click: { target: { ...cap.steps[4].target, description: 'override' } } } }, 'http://localhost:4010/t/beta/login', cap.app.entryUrl);
    expect(steps[4].target?.description).toBe('override');
    expect(steps[0].url).toBe('http://localhost:4010/t/beta/login');
    expect(steps[5].target?.frame.urlPattern).toBe('/t/beta/members');
    expect(steps[3].target).toEqual({ ...cap.steps[3].target, frame: { urlPattern: '/t/beta/login' } });
  });
});

describe('outcome detection and parsing', () => {
  const obs = (text: string): Observation => ({ at: '', url: 'http://x/', title: '', frames: [], elements: [], text, dialogs: [] });
  const profile = AppProfileZ.parse(JSON.parse(fs.readFileSync('apps/legacycore-teller.json', 'utf8')));
  it('separates business outcomes from recoverable conditions and hard failures', () => {
    expect(detect(profile.conditions, obs('No record found for member 99999.'))?.kind).toBe('business');
    expect(detect(profile.conditions, obs('Your session has expired'))?.recovery?.kind).toBe('reauth');
    expect(detect(profile.conditions, obs('Application Error ORA-01033'))?.kind).toBe('hard');
    expect(detect(profile.conditions, obs('MEMBER DETAIL'))).toBeNull();
  });
  it('evaluates checkpoints', () => {
    const o = { ...obs('hello MEMBER DETAIL'), frames: [{ path: 'main', name: 'main', url: 'http://x/t/alpha/members/10001' }] };
    expect(evalCheckpoint({ all: [{ urlMatches: '/t/alpha/members/:id' }, { textPresent: 'member detail' }] }, o).ok).toBe(true);
    expect(evalCheckpoint({ any: [{ textAbsent: 'hello' }, { textMatches: 'DET[A-Z]+' }] }, o).ok).toBe(true);
    expect(evalCheckpoint({ all: [{ urlMatches: '/t/alpha/members/inquire' }] }, o).ok).toBe(false);
  });
  it('parses money and numbers, and refuses garbage', () => {
    expect(parseValue('$4,812.33', 'money')).toBe(4812.33);
    expect(parseValue('-$11,250.00', 'money')).toBe(-11250);
    expect(parseValue('(250.00)', 'money')).toBe(-250);
    expect(parseValue('N/A', 'money')).toBeUndefined();
    expect(parseValue('1,234', 'number')).toBe(1234);
  });
});
