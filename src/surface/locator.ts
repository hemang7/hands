/**
 * Locator strategy: pure functions over ObservedElement records.
 *
 * buildTarget()  - at record time, derive an ordered fallback chain for an element the agent used
 * resolveTarget() - at replay time, walk the chain against a fresh observation, verify the hit
 *                   against the recorded fingerprint, and report which rung of the ladder matched
 *                   (a fallback hit is the drift signal)
 *
 * Ordering rationale (most to least robust for legacy enterprise UIs):
 *   1. role + accessible name   - what a human reads; survives markup rewrites; exists on desktop AX too
 *   2. anchor + role            - "the textbox to the right of 'Member Number'"; the only reliable
 *                                 handle for unlabeled inputs in table layouts
 *   3. attr (tag + name/type)   - generic names like txt1 are ugly but vendors rarely rename them
 *   4. grid (row key + column) - for table cells: "the 'Current Balance' column of the 'Share Savings'
 *                                 row"; tried before anchor for cells because it names the concept
 *   5. text                     - for label-like static content only, never for data values
 *   6. css structural path      - last resort; documented as fragile, never emitted alone
 * No strategy relies on ids or test ids: legacy apps do not have them.
 */
import type { Fingerprint, FrameInfo, LocatorStrategy, ObservedElement, Observation, Resolved, Role, TargetSpec } from './types.js';

export function buildTarget(el: ObservedElement, frames: FrameInfo[]): TargetSpec {
  const strategies: LocatorStrategy[] = [];
  const interactive = el.role === 'button' || el.role === 'link';

  if (interactive && el.name) strategies.push({ kind: 'role', role: el.role, name: el.name });
  if (el.role === 'cell' && el.grid?.colHeader) {
    // Row keys: prefer stable-looking text (not money/dates/numbers/short codes) so the strategy
    // survives data changes between invocations.
    const keys = [...el.grid.rowCells].sort((a, b) => rankRowKey(a) - rankRowKey(b));
    for (const k of keys) strategies.push({ kind: 'grid', row: k, column: el.grid.colHeader });
  }
  if (el.anchor && (el.editable || interactive || el.role === 'cell' || el.role === 'text')) {
    strategies.push({ kind: 'anchor', anchor: el.anchor, role: el.role });
  }
  if (!interactive && el.name && el.name !== el.anchor && el.role !== 'cell' && el.role !== 'text') {
    strategies.push({ kind: 'role', role: el.role, name: el.name });
  }
  if (el.attrs.name || (el.tag === 'input' && el.attrs.type)) {
    strategies.push({ kind: 'attr', tag: el.tag, name: el.attrs.name, type: el.attrs.type, value: el.role === 'button' ? el.attrs.value : undefined });
    // Weak variant for relabeled buttons ("Sign On" -> "Log In"): only accepted when it is the sole
    // control of its kind in the frame (see resolveTarget).
    if (el.role === 'button' && el.attrs.value && !el.attrs.name) strategies.push({ kind: 'attr', tag: el.tag, type: el.attrs.type });
  }
  // Exact-text match only for label-like content; a data value (a balance, a date) would be a false anchor.
  if ((el.role === 'cell' || el.role === 'text' || el.role === 'heading') && el.text && !looksLikeData(el.text) && !el.anchor) {
    strategies.push({ kind: 'text', text: el.text, role: el.role });
  }
  strategies.push({ kind: 'css', selector: el.cssPath });

  const frame = frames.find((f) => f.path === el.frame);
  return {
    description: describe(el),
    frame: { name: frame?.name || undefined, urlPattern: frame ? urlToPattern(frame.url) : undefined },
    strategies: dedupe(strategies),
    // A data value (a balance, an id) is not identity: keep it out of the fingerprint and the artifact.
    fingerprint: { tag: el.tag, role: el.role, name: looksLikeData(el.name) ? '' : el.name, attrName: el.attrs.name, type: el.attrs.type, anchor: el.anchor },
  };
}

export function describe(el: ObservedElement): string {
  const where = el.frame ? ` in frame "${el.frame}"` : '';
  if (el.role === 'cell') {
    if (el.grid?.colHeader) {
      const key = [...el.grid.rowCells].sort((a, b) => rankRowKey(a) - rankRowKey(b))[0];
      return `the "${el.grid.colHeader}" cell of the "${key}" row${where}`;
    }
    if (el.anchor) return `the cell next to "${el.anchor}"${where}`;
  }
  const what = el.role === 'combobox' ? 'dropdown' : el.role === 'textbox' ? 'text box' : el.role;
  const label = el.name || el.anchor || el.text || el.attrs.name || el.tag;
  return `the "${label}" ${what}${where}`;
}

export function matchStrategy(s: LocatorStrategy, elements: ObservedElement[]): ObservedElement[] {
  switch (s.kind) {
    case 'role':
      return elements.filter((e) => e.role === s.role && eqText(e.name, s.name));
    case 'anchor':
      return elements.filter((e) => e.role === s.role && !!e.anchor && eqText(e.anchor, s.anchor));
    case 'text':
      return elements.filter((e) => (!s.role || e.role === s.role) && eqText(e.text, s.text));
    case 'attr':
      return elements.filter(
        (e) =>
          e.tag === s.tag &&
          (s.name === undefined || e.attrs.name === s.name) &&
          (s.type === undefined || (e.attrs.type ?? 'text') === s.type) &&
          (s.value === undefined || e.attrs.value === s.value),
      );
    case 'grid':
      return elements.filter((e) => e.role === 'cell' && !!e.grid?.colHeader && eqText(e.grid.colHeader, s.column) && e.grid.rowCells.some((c) => eqText(c, s.row)));
    case 'css':
      return elements.filter((e) => e.cssPath === s.selector);
  }
}

export function fingerprintScore(fp: Fingerprint, el: ObservedElement): number {
  let score = 0;
  if (fp.tag === el.tag) score += 0.3;
  if (fp.role === el.role) score += 0.3;
  if (fp.attrName && fp.attrName === el.attrs.name) score += 0.2;
  else if (!fp.attrName && !el.attrs.name) score += 0.1;
  if ((fp.type ?? 'text') === (el.attrs.type ?? 'text')) score += 0.1;
  if (eqText(fp.name, el.name) || eqText(fp.anchor ?? '', el.anchor ?? '')) score += 0.1;
  return Math.min(1, score);
}

export interface ResolveOptions {
  minScore?: number; // default 0.5
}

export function resolveTarget(target: TargetSpec, obs: Observation, opts: ResolveOptions = {}): Resolved | null {
  const minScore = opts.minScore ?? 0.5;
  const frames = pickFrames(target, obs.frames);
  const pool = obs.elements.filter((e) => frames.has(e.frame));
  for (let i = 0; i < target.strategies.length; i++) {
    const s = target.strategies[i];
    const hits = matchStrategy(s, pool);
    if (hits.length === 0) continue;
    // Prefer the candidate whose fingerprint agrees with what we recorded.
    const scored = hits.map((e) => ({ e, score: fingerprintScore(target.fingerprint, e) })).sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (best.score < minScore || best.e.role !== target.fingerprint.role) continue;
    // Weak strategies need corroboration: structure alone must never pick a differently-labeled control.
    if (isWeak(s)) {
      const fp = target.fingerprint;
      const labelAgrees = (fp.name && eqText(fp.name, best.e.name)) || (fp.anchor && best.e.anchor && eqText(fp.anchor, best.e.anchor));
      if (s.kind === 'css' && fp.name && !labelAgrees) continue;
      if (s.kind === 'attr' && !labelAgrees && hits.filter((h) => h.role === fp.role).length !== 1) continue;
    }
    return { element: best.e, strategyIndex: i, strategy: s, fingerprintScore: best.score };
  }
  return null;
}

/** css paths and attribute-only matches carry no semantics; they are accepted only with corroboration. */
function isWeak(s: LocatorStrategy): boolean {
  return s.kind === 'css' || (s.kind === 'attr' && !s.name && !s.value);
}

/** Frame selection: by recorded name, else by url pattern, else search everywhere (name drift). */
function pickFrames(target: TargetSpec, frames: FrameInfo[]): Set<string> {
  if (target.frame.name) {
    const byName = frames.filter((f) => f.name === target.frame.name);
    if (byName.length) return new Set(byName.map((f) => f.path));
  }
  if (target.frame.urlPattern) {
    const byUrl = frames.filter((f) => urlMatchesPattern(target.frame.urlPattern!, f.url));
    if (byUrl.length) return new Set(byUrl.map((f) => f.path));
  }
  return new Set(frames.map((f) => f.path));
}

export function urlToPattern(url: string): string {
  try {
    const u = new URL(url);
    // canonicalize numeric path segments and drop the query: /members/10001 -> /members/:id
    const path = u.pathname.replace(/\/\d+(?=\/|$)/g, '/:id');
    return path;
  } catch {
    return url;
  }
}

/**
 * `:id` stands for a segment that was numeric when recorded, so it must contain a digit at replay:
 * /members/:id must not match /members/inquire (the route a failed search lands on).
 */
export function patternToRegex(pattern: string): RegExp {
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:id/g, '[^/]*\\d[^/]*');
  return new RegExp('^' + esc + '/?$');
}

/** Match a url pattern against a full url by its path only. */
export function urlMatchesPattern(pattern: string, url: string): boolean {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {}
  return patternToRegex(pattern).test(pathname);
}

/** Row keys for grid strategies: stable text first, short codes next, data values last. */
export function rankRowKey(t: string): number {
  return looksLikeData(t) ? 2 : /^[A-Z]{0,2}\d{1,3}$/.test(t) ? 1 : 0;
}

/** Money, numbers, dates, ids: values that change between invocations and must not become locators. */
export function looksLikeData(t: string): boolean {
  const s = t.trim();
  return /^-?\$?[\d,]+(\.\d+)?%?$/.test(s) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s) || /^[A-Z]{1,3}\d{4,}$/.test(s);
}

function eqText(a: string, b: string): boolean {
  return norm(a) === norm(b);
}
function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/[:*]+$/, '');
}
function dedupe(list: LocatorStrategy[]): LocatorStrategy[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const k = JSON.stringify(s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const ROLE_LIST: Role[] = ['button', 'link', 'textbox', 'password', 'combobox', 'checkbox', 'radio', 'cell', 'heading', 'text', 'option', 'other'];
