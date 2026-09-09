/**
 * Operator surfaces. All of them speak to the SessionController through the same two calls,
 * takeControl() and handBack(); that pair is the control-transfer seam a real operator console
 * would be built on.
 *
 *   ConsoleOperator   - prints the intervention request; always on
 *   HttpOperator      - minimal web console (list requests, take control, hand back with a
 *                       decision). Pair it with --headed so the person can drive the same browser
 *                       window the automation is using. Deliberately bare: the design is the seam,
 *                       not the UI.
 *   ScriptedOperator  - a "human" for tests and headless evidence runs: takes control, performs
 *                       actions on the same live Playwright page through ordinary Playwright calls
 *                       (exactly what a person does with a mouse), then hands back.
 */
import express from 'express';
import type { Page } from 'playwright';
import type { Server } from 'node:http';
import type { InterventionRequest, Operator, SessionController, Resolution } from './control.js';
import type { Surface } from '../surface/types.js';

export class ConsoleOperator implements Operator {
  notify(req: InterventionRequest) {
    const line = '='.repeat(78);
    console.log(`\n${line}\nINTERVENTION REQUESTED  ${req.id}\n${line}`);
    console.log(`  run:        ${req.runId} (${req.phase})`);
    console.log(`  goal:       ${req.goal}`);
    console.log(`  step:       #${req.stepIndex}${req.stepId ? ` (${req.stepId})` : ''}`);
    console.log(`  cause:      ${req.cause}`);
    console.log(`  url:        ${req.url}`);
    if (req.screenshot) console.log(`  screenshot: ${req.screenshot}`);
    console.log(`  suggested:  ${req.suggestedActions.join(' | ')}`);
    console.log(`  Automation is parked until an operator takes control (run with --operator http to do so from a browser).`);
    console.log(line + '\n');
  }
}

export class HttpOperator implements Operator {
  private server: Server | null = null;
  private ctl: SessionController | null = null;
  constructor(readonly port = Number(process.env.OPERATOR_PORT ?? 4020)) {}

  async start(ctl: SessionController): Promise<void> {
    this.ctl = ctl;
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.get('/api/state', (_req, res) => res.json({ lease: ctl.lease, interventions: ctl.interventions }));
    app.post('/api/interventions/:id/take', async (req, res) => {
      try {
        await ctl.takeControl(String(req.body.operator || 'operator'), req.params.id);
        res.json({ ok: true, lease: ctl.lease });
      } catch (e: any) {
        res.status(409).json({ ok: false, error: e.message });
      }
    });
    app.post('/api/interventions/:id/handback', async (req, res) => {
      try {
        await ctl.handBack(String(req.body.operator || 'operator'), req.body.action as Resolution['action'], String(req.body.note ?? ''));
        res.json({ ok: true, lease: ctl.lease });
      } catch (e: any) {
        res.status(409).json({ ok: false, error: e.message });
      }
    });
    app.post('/dialog', (req, res) => {
      ctl.surface.answerNextDialog(req.body.response === 'accept' ? 'accept' : 'dismiss');
      res.redirect('/');
    });
    app.get('/', (_req, res) => res.send(page(ctl)));
    app.post('/take/:id', async (req, res) => {
      await ctl.takeControl(String(req.body.operator || 'operator'), req.params.id).catch(() => {});
      res.redirect('/');
    });
    app.post('/handback/:id', async (req, res) => {
      await ctl.handBack(String(req.body.operator || 'operator'), req.body.action, String(req.body.note ?? '')).catch(() => {});
      res.redirect('/');
    });
    await new Promise<void>((r) => (this.server = app.listen(this.port, r)));
    console.log(`operator console: http://localhost:${this.port}`);
  }

  notify(req: InterventionRequest) {
    console.log(`>> open http://localhost:${this.port} to take control of the session for ${req.id}`);
  }

  async stop() {
    this.server?.close();
  }
}

function page(ctl: SessionController): string {
  const rows = ctl.interventions
    .slice()
    .reverse()
    .map(
      (r) => `<div style="border:1px solid #ccc;padding:12px;margin:8px 0;background:${r.status === 'open' ? '#fff8dc' : r.status === 'in_progress' ? '#e8f4ff' : '#f4f4f4'}">
<b>${r.id}</b> &middot; ${r.status} &middot; ${r.phase} run ${r.runId}<br>
<b>Goal:</b> ${esc(r.goal)}<br><b>Step:</b> #${r.stepIndex} ${r.stepId ?? ''}<br><b>Stopped because:</b> ${esc(r.cause)}<br>
<b>URL:</b> ${esc(r.url)}<br><b>Screen:</b> <pre style="white-space:pre-wrap;font-size:11px;max-height:120px;overflow:auto">${esc(r.observationSummary)}</pre>
<b>Suggested:</b><ul>${r.suggestedActions.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
${r.status === 'open' ? `<form method="post" action="/take/${r.id}"><input name="operator" value="jane.operator"> <button>Take control of the live session</button></form>` : ''}
${r.status === 'in_progress' ? `<form method="post" action="/handback/${r.id}"><input name="operator" value="${ctl.lease.operator}"> <input name="note" placeholder="what you did" size="40">
<button name="action" value="resume">Hand back: retry step</button> <button name="action" value="skip_step">Hand back: I did this step</button> <button name="action" value="abort">Abort run</button></form>
<form method="post" action="/dialog">Next native dialog: <button name="response" value="accept">OK</button> <button name="response" value="dismiss">Cancel</button> <small>(dialogs are cancelled unless answered here first)</small></form>
<p style="color:#555">You hold the session. Use the automation's browser window now; your actions are being recorded.</p>` : ''}
</div>`,
    )
    .join('');
  return `<html><head><title>hands operator console</title><meta http-equiv="refresh" content="3"></head><body style="font-family:system-ui;max-width:900px;margin:20px auto">
<h2>hands &middot; operator console</h2><p>Session lease: <b>${ctl.lease.holder}${ctl.lease.operator ? ` (${ctl.lease.operator})` : ''}</b> since ${ctl.lease.since}${ctl.lease.reason ? ` &middot; ${esc(ctl.lease.reason)}` : ''}</p>
${rows || '<p>No interventions yet.</p>'}</body></html>`;
}

function esc(s: string) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

export type ScriptedHuman = (req: InterventionRequest, page: Page, surface: Surface) => Promise<{ action: Resolution['action']; note: string }>;

export class ScriptedOperator implements Operator {
  constructor(
    private page: Page,
    private human: ScriptedHuman,
    readonly name = 'scripted.operator',
    private delayMs = 300,
  ) {}
  async notify(req: InterventionRequest, ctl: SessionController) {
    // Not awaited by the controller's caller: the human "arrives" shortly after the request is raised.
    setTimeout(async () => {
      try {
        await ctl.takeControl(this.name, req.id);
        const { action, note } = await this.human(req, this.page, ctl.surface);
        await ctl.handBack(this.name, action, note);
      } catch (e: any) {
        console.error('scripted operator failed:', e.message);
        try {
          await ctl.handBack(this.name, 'abort', `operator error: ${e.message}`);
        } catch {}
      }
    }, this.delayMs);
  }
}
