/**
 * Guardrails. Two questions, asked before *every* action in both discovery and replay:
 *   1. Is this action inside the allowlist? (origin, route, action kind)
 *   2. What is its risk class, and is that class permitted in this phase with this authority?
 *
 * Risk classes:
 *   safe         - reading, navigating within the app, typing into a field
 *   reversible   - submits that move through a flow but do not commit to the host (search, continue, back)
 *   irreversible - controls that post/commit (Confirm, Post, Transfer...) or accepting a confirm() dialog
 *
 * Handling of irreversible actions is conservative by construction:
 *   discovery: blocked unless the run was started with allowIrreversible AND the model explicitly
 *              acknowledges the action as irreversible in its tool call (two independent consents)
 *   replay:    requires an *approved* artifact AND a per-invocation confirm flag from the caller;
 *              otherwise the engine escalates to a human rather than guessing
 */
import type { ObservedElement, SurfaceAction } from '../surface/types.js';
import type { Risk } from '../artifact/schema.js';

export interface PolicyConfig {
  allowlist: {
    origins: string[];
    routes: string[]; // path prefixes or patterns with :id; empty = any path on allowed origins
    actions: string[]; // permitted step/action kinds
  };
  /** Regex (case-insensitive) over a control's accessible name that marks it as committing. */
  irreversibleControlPattern?: string;
  /** Regex over the route that marks any submit on it as committing. */
  irreversibleRoutePattern?: string;
}

export interface Verdict {
  allowed: boolean;
  risk: Risk;
  reason: string;
}

export interface Authority {
  phase: 'discovery' | 'replay';
  allowIrreversible?: boolean; // discovery flag
  modelAcknowledged?: boolean; // discovery: the model set confirmIrreversible=true
  artifactApproved?: boolean; // replay
  callerConfirmed?: boolean; // replay
}

export class PolicyEngine {
  constructor(readonly cfg: PolicyConfig) {}

  urlAllowed(url: string): { ok: boolean; reason: string } {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { ok: false, reason: `unparseable url ${url}` };
    }
    if (!this.cfg.allowlist.origins.includes(u.origin)) return { ok: false, reason: `origin ${u.origin} not in allowlist` };
    if (this.cfg.allowlist.routes.length) {
      const ok = this.cfg.allowlist.routes.some((r) => routeMatches(r, u.pathname));
      if (!ok) return { ok: false, reason: `route ${u.pathname} not in allowlist` };
    }
    return { ok: true, reason: 'url allowed' };
  }

  classify(action: SurfaceAction | { kind: 'extract' }, el?: ObservedElement, currentUrl?: string): Risk {
    if (action.kind === 'type' || action.kind === 'select' || action.kind === 'extract' || action.kind === 'wait' || action.kind === 'navigate') return 'safe';
    if (action.kind === 'press') return 'reversible';
    if (action.kind === 'click') {
      if (action.acceptDialog) return 'irreversible';
      if (!el) return 'reversible';
      const name = (el.name || el.text || '').trim();
      if (this.cfg.irreversibleControlPattern && new RegExp(this.cfg.irreversibleControlPattern, 'i').test(name)) return 'irreversible';
      if (this.cfg.irreversibleRoutePattern && currentUrl && new RegExp(this.cfg.irreversibleRoutePattern, 'i').test(currentUrl) && el.role === 'button') return 'irreversible';
      if (el.role === 'button') return 'reversible';
      return 'safe';
    }
    return 'reversible';
  }

  authorize(action: SurfaceAction | { kind: 'extract' }, auth: Authority, el?: ObservedElement, currentUrl?: string): Verdict {
    const risk = this.classify(action, el, currentUrl);
    if (!this.cfg.allowlist.actions.includes(action.kind as any)) return { allowed: false, risk, reason: `action "${action.kind}" not in allowlist` };
    if (action.kind === 'navigate') {
      const v = this.urlAllowed(action.url);
      if (!v.ok) return { allowed: false, risk, reason: v.reason };
    }
    if (action.kind === 'click' && el?.attrs.href) {
      const abs = safeResolve(el.attrs.href, currentUrl);
      if (abs && !abs.startsWith('javascript:')) {
        const v = this.urlAllowed(abs);
        if (!v.ok) return { allowed: false, risk, reason: `link leaves allowlist: ${v.reason}` };
      }
    }
    if (risk === 'irreversible') {
      if (auth.phase === 'discovery') {
        if (!auth.allowIrreversible) return { allowed: false, risk, reason: 'irreversible action; discovery run was not started with --allow-irreversible' };
        if (!auth.modelAcknowledged) return { allowed: false, risk, reason: 'irreversible action; model must set confirmIrreversible=true to proceed' };
      } else {
        if (!auth.artifactApproved) return { allowed: false, risk, reason: 'irreversible step; artifact is not approved' };
        if (!auth.callerConfirmed) return { allowed: false, risk, reason: 'irreversible step; caller did not pass confirm=true' };
      }
    }
    return { allowed: true, risk, reason: `${risk} action permitted` };
  }
}

export function routeMatches(pattern: string, pathname: string): boolean {
  const re = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:id/g, '[^/]+').replace(/\\\*/g, '.*'));
  return re.test(pathname);
}

function safeResolve(href: string, base?: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}
