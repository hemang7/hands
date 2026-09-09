import { describe, expect, it } from 'vitest';
import { buildTarget, looksLikeData, patternToRegex, resolveTarget, urlMatchesPattern, urlToPattern } from '../src/surface/locator.js';
import type { ObservedElement, Observation } from '../src/surface/types.js';

const el = (p: Partial<ObservedElement> & { ref: number; role: ObservedElement['role'] }): ObservedElement => ({
  frame: 'main',
  name: '',
  text: '',
  tag: 'input',
  attrs: {},
  cssPath: `body > input:nth-of-type(${p.ref})`,
  bbox: { x: 0, y: 0, w: 10, h: 10 },
  enabled: true,
  editable: p.role === 'textbox',
  ...p,
});
const obs = (elements: ObservedElement[], frames = [{ path: 'main', name: 'main', url: 'http://x/t/alpha/members' }]): Observation => ({
  at: '',
  url: 'http://x/t/alpha/console',
  title: '',
  frames,
  elements,
  text: '',
  dialogs: [],
});

describe('buildTarget', () => {
  it('orders strategies from semantic to structural and never relies on ids', () => {
    const t = buildTarget(el({ ref: 1, role: 'textbox', name: 'Member Number', anchor: 'Member Number', attrs: { name: 'txt1', type: 'text' } }), obs([]).frames);
    expect(t.strategies.map((s) => s.kind)).toEqual(['anchor', 'attr', 'css']);
    expect(JSON.stringify(t)).not.toMatch(/#|data-testid/);
    expect(t.frame.urlPattern).toBe('/t/alpha/members');
  });
  it('for table cells prefers grid(row,column) with stable row keys before anchors, and keeps data values out of the fingerprint', () => {
    const cell = el({ ref: 9, role: 'cell', tag: 'td', name: '$4,812.33', text: '$4,812.33', anchor: 'PRIMARY SAVINGS', grid: { colHeader: 'Current Balance', rowCells: ['S01', 'Share Savings', 'PRIMARY SAVINGS'] } });
    const t = buildTarget(cell, obs([]).frames);
    expect(t.strategies[0]).toEqual({ kind: 'grid', row: 'Share Savings', column: 'Current Balance' });
    expect(t.strategies.find((s) => s.kind === 'text')).toBeUndefined();
    expect(t.fingerprint.name).toBe('');
    expect(t.description).toBe('the "Current Balance" cell of the "Share Savings" row in frame "main"');
  });
});

describe('resolveTarget', () => {
  const inquire = el({ ref: 2, role: 'button', name: 'Inquire', attrs: { type: 'submit', value: 'Inquire' } });
  const target = buildTarget(inquire, obs([]).frames);

  it('matches the primary strategy on an identical screen', () => {
    const r = resolveTarget(target, obs([inquire]));
    expect(r?.strategyIndex).toBe(0);
  });
  it('falls back when the label changes, but only if the control is unambiguous (drift signal)', () => {
    const relabeled = el({ ref: 2, role: 'button', name: 'Search', attrs: { type: 'submit', value: 'Search' } });
    const r = resolveTarget(target, obs([relabeled]));
    expect(r?.element.name).toBe('Search');
    expect(r?.strategy.kind).toBe('attr');
    expect(r!.strategyIndex).toBeGreaterThan(0);
  });
  it('refuses a weak structural match when two candidates exist', () => {
    const a = el({ ref: 2, role: 'button', name: 'Search', attrs: { type: 'submit', value: 'Search' } });
    const b = el({ ref: 3, role: 'button', name: 'Delete', attrs: { type: 'submit', value: 'Delete' }, cssPath: 'body > input:nth-of-type(3)' });
    expect(resolveTarget(target, obs([a, b]))).toBeNull();
  });
  it('never lets a css path pick a differently-labelled control', () => {
    const link = el({ ref: 5, role: 'link', tag: 'a', name: 'Member Inquiry', cssPath: 'body > table > tr:nth-of-type(3) > td > a', frame: 'menu' });
    const t = buildTarget(link, [{ path: 'menu', name: 'menu', url: 'http://x/t/alpha/frame/menu' }]);
    const other = el({ ref: 5, role: 'link', tag: 'a', name: 'Teller Drawer', cssPath: 'body > table > tr:nth-of-type(3) > td > a', frame: 'menu' });
    expect(resolveTarget(t, obs([other], [{ path: 'menu', name: 'menu', url: 'http://x/t/beta/frame/menu' }]))).toBeNull();
  });
  it('searches all frames when the recorded frame name is gone (renamed frames)', () => {
    const r = resolveTarget(target, obs([{ ...inquire, frame: 'content' }], [{ path: 'content', name: 'content', url: 'http://x/t/beta/members' }]));
    expect(r?.element.frame).toBe('content');
  });
  it('rejects a candidate whose role differs from the recorded fingerprint', () => {
    const t = buildTarget(el({ ref: 1, role: 'textbox', anchor: 'Member Number', attrs: { name: 'txt1', type: 'text' } }), obs([]).frames);
    const impostor = el({ ref: 1, role: 'button', anchor: 'Member Number', attrs: { name: 'txt1', type: 'submit' } });
    expect(resolveTarget(t, obs([impostor]))).toBeNull();
  });
});

describe('url patterns', () => {
  it('canonicalizes numeric segments and only matches digit-bearing segments back', () => {
    expect(urlToPattern('http://x/t/alpha/members/10001?x=1')).toBe('/t/alpha/members/:id');
    expect(urlMatchesPattern('/t/alpha/members/:id', 'http://x/t/alpha/members/10003')).toBe(true);
    expect(urlMatchesPattern('/t/alpha/members/:id', 'http://x/t/alpha/members/inquire')).toBe(false);
    expect(patternToRegex('/a/b').test('/a/b/')).toBe(true);
    expect(patternToRegex('/a/b').test('/x/a/b')).toBe(false);
  });
  it('recognizes data-like text', () => {
    expect(looksLikeData('$4,812.33')).toBe(true);
    expect(looksLikeData('03/14/2011')).toBe(true);
    expect(looksLikeData('HC12345678')).toBe(true);
    expect(looksLikeData('Share Savings')).toBe(false);
  });
});
