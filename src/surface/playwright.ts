/**
 * PlaywrightSurface: the one concrete Surface in this submission.
 *
 * Deliberately avoids anything a legacy app would not give us: no ids, no test ids, no
 * page.locator('#foo'). Perception is a cross-frame walk that produces role/name/anchor records;
 * action is done on element handles recovered from those records. Frames are first-class because
 * framesets are the norm in the target environment.
 */
import type { Browser, BrowserContext, Dialog, Frame, Page } from 'playwright';
import { chromium } from 'playwright';
import { INDEXER_SOURCE, type IndexerResult } from "./indexer.js";
import { resolveTarget } from './locator.js';
import type { DialogInfo, FrameInfo, HumanEvent, Observation, ObservedElement, Resolved, Surface, SurfaceAction, TargetSpec } from './types.js';

export interface PlaywrightSurfaceOptions {
  headless?: boolean;
  settleTimeoutMs?: number;
  slowMo?: number;
}

export class SettleTimeoutError extends Error {
  constructor(ms: number) {
    super(`surface did not settle within ${ms}ms (navigation still pending)`);
  }
}

export class PlaywrightSurface implements Surface {
  readonly kind = 'web' as const;
  private refMap = new Map<number, { frame: Frame; local: number }>();
  private lastObs: Observation | null = null;
  private dialogs: DialogInfo[] = [];
  private dialogPolicy: 'accept' | 'dismiss' = 'dismiss';
  private pendingNav = new Set<string>();
  private humanHandler: ((e: HumanEvent) => void) | null = null;
  private settleTimeoutMs: number;

  private constructor(
    private browser: Browser | null,
    private context: BrowserContext,
    readonly page: Page,
    opts: PlaywrightSurfaceOptions,
  ) {
    this.settleTimeoutMs = opts.settleTimeoutMs ?? 8000;
    page.on('dialog', (d) => this.onDialog(d));
    page.on('request', (r) => {
      if (r.isNavigationRequest()) this.pendingNav.add(r.url() + '#' + (r.frame()?.name() ?? ''));
    });
    const clear = (r: any) => this.pendingNav.delete(r.url() + '#' + (r.frame()?.name() ?? ''));
    page.on('response', (res) => clear(res.request()));
    page.on('requestfailed', clear);
    page.on('framenavigated', (f) => {
      if (this.humanHandler) {
        this.humanHandler({ at: new Date().toISOString(), frame: this.framePath(f), kind: 'navigate', target: f.url() });
        this.injectHumanCapture(f).catch(() => {});
      }
    });
  }

  static async launch(opts: PlaywrightSurfaceOptions = {}): Promise<PlaywrightSurface> {
    const browser = await chromium.launch({
      headless: opts.headless ?? true,
      slowMo: opts.slowMo,
      // Optional: point at a system Chromium instead of the Playwright-managed download.
      executablePath: process.env.HANDS_CHROMIUM_PATH || undefined,
    });
    const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
    const page = await context.newPage();
    const s = new PlaywrightSurface(browser, context, page, opts);
    await s.installBindings();
    return s;
  }

  /** Attach to an existing page (used by tests and by the operator to share the live session). */
  static async attach(page: Page, opts: PlaywrightSurfaceOptions = {}): Promise<PlaywrightSurface> {
    const s = new PlaywrightSurface(null, page.context(), page, opts);
    await s.installBindings();
    return s;
  }

  private async installBindings() {
    await this.page.exposeBinding('__handsHuman', (_src, e: HumanEvent) => {
      this.humanHandler?.(e);
    });
  }

  private nextDialogResponse: 'accept' | 'dismiss' | null = null;

  /**
   * Native dialogs cannot reach a person through Playwright, so whoever holds the session answers
   * them ahead of time: automation via the step's `dialog` field, a human via this call (the
   * operator console exposes it as "answer the next dialog"). Unanswered dialogs are dismissed.
   */
  answerNextDialog(response: 'accept' | 'dismiss') {
    this.nextDialogResponse = response;
  }

  private onDialog(d: Dialog) {
    const policy = this.nextDialogResponse ?? this.dialogPolicy;
    this.nextDialogResponse = null;
    const handledAs = policy === 'accept' ? 'accepted' : 'dismissed';
    this.dialogs.push({ type: d.type(), message: d.message(), handledAs });
    this.humanHandler?.({ at: new Date().toISOString(), frame: '', kind: 'dialog', target: `${d.type()} "${d.message()}" ${handledAs}` });
    (handledAs === 'accepted' ? d.accept() : d.dismiss()).catch(() => {});
  }

  currentUrl(): string {
    return this.page.url();
  }

  private framePath(f: Frame): string {
    const parts: string[] = [];
    let cur: Frame | null = f;
    while (cur && cur.parentFrame()) {
      parts.unshift(cur.name() || `frame${cur.parentFrame()!.childFrames().indexOf(cur)}`);
      cur = cur.parentFrame();
    }
    return parts.join('/');
  }

  async observe(): Promise<Observation> {
    await this.settle().catch(() => {});
    const frames: FrameInfo[] = [];
    const elements: ObservedElement[] = [];
    const texts: string[] = [];
    this.refMap.clear();
    let ref = 0;
    for (const f of this.page.frames()) {
      const path = this.framePath(f);
      let res;
      try {
        res = (await f.evaluate(INDEXER_SOURCE)) as IndexerResult;
      } catch {
        continue; // frame detached mid-walk; re-observe next loop
      }
      frames.push({ path, name: f.name(), url: f.url() });
      if (res.text) texts.push(path ? `[frame ${path}] ${res.text}` : res.text);
      for (const e of res.elements) {
        this.refMap.set(ref, { frame: f, local: e.ref });
        elements.push({ ...e, ref, frame: path, role: e.role as ObservedElement['role'] });
        ref++;
      }
    }
    const obs: Observation = {
      at: new Date().toISOString(),
      url: this.page.url(),
      title: await this.page.title().catch(() => ''),
      frames,
      elements,
      text: texts.join('\n').slice(0, 6000),
      dialogs: this.dialogs.splice(0),
    };
    this.lastObs = obs;
    return obs;
  }

  async resolve(target: TargetSpec): Promise<Resolved | null> {
    const obs = await this.observe();
    return resolveTarget(target, obs);
  }

  private async handle(ref: number) {
    const m = this.refMap.get(ref);
    if (!m) throw new Error(`unknown ref ${ref}; observe() first`);
    const h = await m.frame.evaluateHandle((i: number) => (window as any).__hands?.[i], m.local);
    const el = h.asElement();
    if (!el) throw new Error(`ref ${ref} is no longer attached`);
    return el;
  }

  async act(action: SurfaceAction): Promise<void> {
    switch (action.kind) {
      case 'navigate':
        await this.page.goto(action.url, { waitUntil: 'load' });
        break;
      case 'click': {
        this.dialogPolicy = action.acceptDialog ? 'accept' : 'dismiss';
        const el = await this.handle(action.ref);
        await el.click({ timeout: 5000 });
        this.dialogPolicy = 'dismiss';
        break;
      }
      case 'type': {
        const el = await this.handle(action.ref);
        await el.fill(action.text, { timeout: 5000 });
        if (action.submit) await el.press('Enter');
        break;
      }
      case 'select': {
        const el = await this.handle(action.ref);
        await el.selectOption({ label: action.option }, { timeout: 5000 });
        break;
      }
      case 'press':
        await this.page.keyboard.press(action.key);
        break;
      case 'wait':
        await this.page.waitForTimeout(action.ms);
        break;
    }
    await this.settle();
  }

  /**
   * Quiescence: no navigation request in flight, every frame at readyState complete.
   * Throws SettleTimeoutError so the replay engine can classify a slow host explicitly.
   */
  async settle(timeoutMs = this.settleTimeoutMs): Promise<void> {
    const start = Date.now();
    await this.page.waitForTimeout(120); // let a click's navigation request get issued
    while (Date.now() - start < timeoutMs) {
      if (this.pendingNav.size === 0) {
        const states = await Promise.all(
          this.page.frames().map((f) => f.evaluate(() => document.readyState).catch(() => 'loading')),
        );
        if (states.every((s) => s === 'complete')) return;
      }
      await this.page.waitForTimeout(100);
    }
    throw new SettleTimeoutError(timeoutMs);
  }

  async waitQuiescent(timeoutMs: number): Promise<boolean> {
    try {
      await this.settle(timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  async readText(ref: number): Promise<string> {
    const e = this.lastObs?.elements.find((x) => x.ref === ref);
    if (!e) throw new Error(`unknown ref ${ref}`);
    return e.text || e.attrs.value || e.name;
  }

  async screenshot(path: string): Promise<void> {
    await this.page.screenshot({ path, fullPage: true }).catch(() => {});
  }

  async snapshot(): Promise<string> {
    const parts: string[] = [];
    for (const f of this.page.frames()) {
      const html = await f.evaluate(() => document.documentElement.outerHTML).catch(() => '<detached/>');
      parts.push(`<!-- frame path="${this.framePath(f)}" name="${f.name()}" url="${f.url()}" -->\n${html}`);
    }
    return parts.join('\n\n');
  }

  // ---- human control capture ----
  async startHumanCapture(onEvent: (e: HumanEvent) => void): Promise<void> {
    this.humanHandler = onEvent;
    for (const f of this.page.frames()) await this.injectHumanCapture(f).catch(() => {});
  }
  async stopHumanCapture(): Promise<void> {
    this.humanHandler = null;
  }
  private async injectHumanCapture(f: Frame) {
    const path = this.framePath(f);
    // Source string, not a function: keeps bundler helpers (esbuild's __name) out of page context.
    await f.evaluate(HUMAN_CAPTURE_SOURCE.replace('__FRAME_PATH__', JSON.stringify(path)));
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }
}

const HUMAN_CAPTURE_SOURCE = String.raw`(() => {
  const w = window;
  if (w.__handsCaptureInstalled) return;
  w.__handsCaptureInstalled = true;
  const framePath = __FRAME_PATH__;
  const desc = (el) => {
    if (!el) return '?';
    const label = el.getAttribute('aria-label') || el.value || (el.textContent || '').trim() || el.getAttribute('name') || '';
    return el.tagName.toLowerCase() + (el.type ? '[type=' + el.type + ']' : '') + ' "' + String(label).slice(0, 40) + '"';
  };
  const send = (kind, el, value) => w.__handsHuman({ at: new Date().toISOString(), frame: framePath, kind, target: desc(el), value });
  document.addEventListener('click', (ev) => send('click', ev.target), true);
  document.addEventListener('change', (ev) => { const t = ev.target; send('input', t, t.type === 'password' ? '[redacted]' : t.value); }, true);
  document.addEventListener('submit', (ev) => send('submit', ev.target), true);
})()`;
