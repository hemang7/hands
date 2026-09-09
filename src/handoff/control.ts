/**
 * Control-transfer model for one live session.
 *
 * Exactly one party holds the lease on the session at any time: automation or a named human.
 * Automation checks the lease before every action; while a human holds it, automation is parked in
 * requestIntervention() awaiting a resolution. The human operates the *same* browser page (headed
 * mode, or a scripted operator attached to the same page in tests), so state, cookies and the
 * frame tree carry across the handoff. Everything the human does is captured as HumanEvents and
 * attached to the resolution, which the run's evidence records.
 *
 * States:  AUTOMATION --(intervention raised)--> WAITING_FOR_HUMAN --(take)--> HUMAN
 *          HUMAN --(hand back: resume|skip_step|abort)--> AUTOMATION
 *          WAITING_FOR_HUMAN --(timeout)--> AUTOMATION (resolution = abort/timeout)
 */
import { EventEmitter } from 'node:events';
import type { HumanEvent, Surface } from '../surface/types.js';

export type Holder = 'automation' | 'human';

export interface Lease {
  holder: Holder;
  operator?: string;
  since: string;
  reason?: string;
}

export interface InterventionRequest {
  id: string;
  runId: string;
  phase: 'discovery' | 'replay';
  capability?: string;
  goal: string;
  stepIndex: number;
  stepId?: string;
  reason: string;
  /** Why automation stopped, in the words of the engine (outcome code, policy verdict, model's own reason). */
  cause: string;
  url: string;
  screenshot?: string;
  observationSummary: string;
  suggestedActions: string[];
  createdAt: string;
  status: 'open' | 'in_progress' | 'resolved' | 'expired';
}

export interface Resolution {
  action: 'resume' | 'skip_step' | 'abort';
  note: string;
  operator: string;
  humanActions: HumanEvent[];
  takenAt?: string;
  resolvedAt: string;
}

export interface Operator {
  /** Called when an intervention is raised. The operator takes control via the controller. */
  notify(req: InterventionRequest, ctl: SessionController): void | Promise<void>;
}

export class SessionController extends EventEmitter {
  lease: Lease = { holder: 'automation', since: new Date().toISOString() };
  readonly interventions: InterventionRequest[] = [];
  private pending: { req: InterventionRequest; resolve: (r: Resolution) => void; humanActions: HumanEvent[]; takenAt?: string } | null = null;

  constructor(
    readonly surface: Surface,
    private operators: Operator[] = [],
    private timeoutMs = 10 * 60 * 1000,
  ) {
    super();
  }

  addOperator(op: Operator) {
    this.operators.push(op);
  }

  /** Automation must call this before acting. */
  assertAutomationMayAct(): void {
    if (this.lease.holder !== 'automation') throw new Error(`automation attempted to act while ${this.lease.operator ?? 'a human'} holds the session`);
  }

  currentRequest(): InterventionRequest | null {
    return this.pending?.req ?? null;
  }

  /** Park automation, publish the request, and wait for a human to resolve it (or time out). */
  async requestIntervention(partial: Omit<InterventionRequest, 'id' | 'createdAt' | 'status'>): Promise<Resolution> {
    if (this.pending) throw new Error('an intervention is already pending');
    const req: InterventionRequest = { ...partial, id: `int-${Date.now().toString(36)}`, createdAt: new Date().toISOString(), status: 'open' };
    this.interventions.push(req);
    this.emit('intervention', req);
    const resolution = new Promise<Resolution>((resolve) => {
      this.pending = { req, resolve, humanActions: [] };
    });
    for (const op of this.operators) await op.notify(req, this);
    const timer = setTimeout(() => {
      if (this.pending?.req.id === req.id && req.status !== 'resolved') {
        req.status = 'expired';
        this.finish({ action: 'abort', note: `no operator responded within ${this.timeoutMs}ms`, operator: 'system', humanActions: [], resolvedAt: new Date().toISOString() });
      }
    }, this.timeoutMs);
    const r = await resolution;
    clearTimeout(timer);
    return r;
  }

  /** A human takes the live session. Automation is already parked; we start capturing their actions. */
  async takeControl(operator: string, interventionId?: string): Promise<InterventionRequest> {
    const p = this.pending;
    if (!p) throw new Error('no intervention is pending');
    if (interventionId && p.req.id !== interventionId) throw new Error(`intervention ${interventionId} is not the pending one`);
    if (this.lease.holder === 'human') throw new Error(`${this.lease.operator} already holds the session`);
    this.lease = { holder: 'human', operator, since: new Date().toISOString(), reason: p.req.reason };
    p.req.status = 'in_progress';
    p.takenAt = this.lease.since;
    await this.surface.startHumanCapture((e) => {
      p.humanActions.push(e);
      this.emit('humanAction', e);
    });
    this.emit('lease', this.lease);
    return p.req;
  }

  /** The human hands the session back with a decision about how automation should continue. */
  async handBack(operator: string, action: Resolution['action'], note = ''): Promise<void> {
    const p = this.pending;
    if (!p) throw new Error('no intervention is pending');
    if (this.lease.holder !== 'human' || this.lease.operator !== operator) throw new Error(`${operator} does not hold the session`);
    await this.surface.stopHumanCapture();
    this.finish({ action, note, operator, humanActions: p.humanActions, takenAt: p.takenAt, resolvedAt: new Date().toISOString() });
  }

  private finish(r: Resolution) {
    const p = this.pending;
    if (!p) return;
    p.req.status = p.req.status === 'expired' ? 'expired' : 'resolved';
    this.pending = null;
    this.lease = { holder: 'automation', since: new Date().toISOString(), reason: `resumed after ${r.action} by ${r.operator}` };
    this.emit('lease', this.lease);
    this.emit('resolved', { req: p.req, resolution: r });
    p.resolve(r);
  }
}
