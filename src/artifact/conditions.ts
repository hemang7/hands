/**
 * Condition evaluation: checkpoints, success conditions and outcome detectors all use the same
 * small vocabulary, evaluated against an Observation. Pure and synchronous: easy to test, and the
 * same evaluator serves the discovery agent (to record what it saw) and the replay engine.
 */
import { urlMatchesPattern } from '../surface/locator.js';
import type { Observation } from '../surface/types.js';
import type { Checkpoint, Condition } from './schema.js';

export interface ConditionResult {
  ok: boolean;
  detail: string;
}

export function evalCondition(c: Condition, obs: Observation): ConditionResult {
  if ('urlMatches' in c) {
    const urls = [obs.url, ...obs.frames.map((f) => f.url)];
    const hit = urls.find((u) => urlMatchesPattern(c.urlMatches, u));
    return { ok: !!hit, detail: hit ? `url ${hit} matches ${c.urlMatches}` : `no url matches ${c.urlMatches} (have: ${urls.join(', ')})` };
  }
  if ('textPresent' in c) {
    const ok = obs.text.toLowerCase().includes(c.textPresent.toLowerCase());
    return { ok, detail: `${ok ? 'found' : 'missing'} text "${c.textPresent}"` };
  }
  if ('textMatches' in c) {
    const ok = new RegExp(c.textMatches, 'i').test(obs.text);
    return { ok, detail: `text ${ok ? 'matches' : 'does not match'} /${c.textMatches}/` };
  }
  if ('textAbsent' in c) {
    const ok = !obs.text.toLowerCase().includes(c.textAbsent.toLowerCase());
    return { ok, detail: `text "${c.textAbsent}" ${ok ? 'absent' : 'present'}` };
  }
  if ('elementPresent' in c) {
    const ok = obs.elements.some((e) => e.role === c.elementPresent.role && norm(e.name) === norm(c.elementPresent.name));
    return { ok, detail: `${c.elementPresent.role} "${c.elementPresent.name}" ${ok ? 'present' : 'missing'}` };
  }
  if ('dialogSeen' in c) {
    const re = new RegExp(c.dialogSeen, 'i');
    const ok = obs.dialogs.some((d) => re.test(d.message));
    return { ok, detail: `dialog /${c.dialogSeen}/ ${ok ? 'seen' : 'not seen'}` };
  }
  return { ok: false, detail: 'unknown condition' };
}

export function evalCheckpoint(cp: Checkpoint, obs: Observation): ConditionResult {
  const details: string[] = [];
  if (cp.all?.length) {
    for (const c of cp.all) {
      const r = evalCondition(c, obs);
      details.push(r.detail);
      if (!r.ok) return { ok: false, detail: `all: ${r.detail}` };
    }
  }
  if (cp.any?.length) {
    const results = cp.any.map((c) => evalCondition(c, obs));
    const hit = results.find((r) => r.ok);
    if (!hit) return { ok: false, detail: `any: none matched (${results.map((r) => r.detail).join('; ')})` };
    details.push(hit.detail);
  }
  return { ok: true, detail: details.join('; ') || 'no conditions' };
}

export function describeCheckpoint(cp: Checkpoint): string {
  const one = (c: Condition) => Object.entries(c).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)}`)[0];
  const parts: string[] = [];
  if (cp.all?.length) parts.push('all(' + cp.all.map(one).join(', ') + ')');
  if (cp.any?.length) parts.push('any(' + cp.any.map(one).join(', ') + ')');
  return parts.join(' and ') || 'none';
}

function norm(s: string) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}
