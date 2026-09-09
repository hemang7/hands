import { describe, expect, it } from 'vitest';
import { SessionController } from '../src/handoff/control.js';
import type { HumanEvent, Surface } from '../src/surface/types.js';

function fakeSurface() {
  let handler: ((e: HumanEvent) => void) | null = null;
  const s = {
    kind: 'web',
    answerNextDialog: () => {},
    startHumanCapture: async (h: (e: HumanEvent) => void) => {
      handler = h;
    },
    stopHumanCapture: async () => {
      handler = null;
    },
    humanClicks: (t: string) => handler?.({ at: 'now', frame: 'main', kind: 'click', target: t }),
    capturing: () => handler !== null,
  } as unknown as Surface & { humanClicks: (t: string) => void; capturing: () => boolean };
  return s;
}

const req = { runId: 'r1', phase: 'replay' as const, goal: 'g', stepIndex: 3, stepId: 's3', reason: 'stuck', cause: 'TARGET_NOT_FOUND', url: 'http://x', observationSummary: '', suggestedActions: [] };

describe('SessionController (control-transfer model)', () => {
  it('parks automation, lets exactly one human take the session, records their actions, and hands back', async () => {
    const surface = fakeSurface();
    const ctl = new SessionController(surface, [], 5000);
    const pending = ctl.requestIntervention(req);
    expect(ctl.lease.holder).toBe('automation'); // parked, but nobody holds it yet
    expect(ctl.currentRequest()?.status).toBe('open');

    await ctl.takeControl('jane');
    expect(ctl.lease).toMatchObject({ holder: 'human', operator: 'jane' });
    expect(() => ctl.assertAutomationMayAct()).toThrow(/jane holds the session/);
    await expect(ctl.takeControl('bob')).rejects.toThrow(/already holds/);
    expect(surface.capturing()).toBe(true);
    surface.humanClicks('a "Customer Lookup"');

    await expect(ctl.handBack('bob', 'resume')).rejects.toThrow(/does not hold/);
    await ctl.handBack('jane', 'skip_step', 'did it');
    const res = await pending;
    expect(res).toMatchObject({ action: 'skip_step', operator: 'jane', note: 'did it' });
    expect(res.humanActions.map((a) => a.target)).toEqual(['a "Customer Lookup"']);
    expect(surface.capturing()).toBe(false);
    expect(ctl.lease.holder).toBe('automation');
    expect(ctl.interventions[0].status).toBe('resolved');
    ctl.assertAutomationMayAct();
  });

  it('times out into an abort resolution when no operator answers', async () => {
    const ctl = new SessionController(fakeSurface(), [], 50);
    const res = await ctl.requestIntervention(req);
    expect(res.action).toBe('abort');
    expect(ctl.interventions[0].status).toBe('expired');
    expect(ctl.lease.holder).toBe('automation');
  });

  it('notifies operators and refuses a second concurrent intervention', async () => {
    const seen: string[] = [];
    const ctl = new SessionController(fakeSurface(), [{ notify: (r) => void seen.push(r.id) }], 50);
    const p = ctl.requestIntervention(req);
    await expect(ctl.requestIntervention(req)).rejects.toThrow(/already pending/);
    await p;
    expect(seen).toHaveLength(1);
  });
});
