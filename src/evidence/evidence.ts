/**
 * Evidence: one directory per run, a structured JSONL event log, screenshots at every step,
 * and on failure a full DOM snapshot of every frame. Everything written passes the Redactor.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Surface } from '../surface/types.js';
import { Redactor } from '../policy/redact.js';

export interface RunEvent {
  t: string;
  seq: number;
  type: string;
  [k: string]: unknown;
}

export class Evidence {
  readonly dir: string;
  private seq = 0;
  private stream: fs.WriteStream;

  constructor(
    readonly runId: string,
    readonly redactor: Redactor,
    root = path.resolve('runs'),
    private echo = true,
  ) {
    this.dir = path.join(root, runId);
    fs.mkdirSync(path.join(this.dir, 'shots'), { recursive: true });
    this.stream = fs.createWriteStream(path.join(this.dir, 'run.jsonl'), { flags: 'a' });
  }

  log(type: string, data: Record<string, unknown> = {}): RunEvent {
    const ev: RunEvent = this.redactor.scrubDeep({ t: new Date().toISOString(), seq: this.seq++, type, ...data });
    this.stream.write(JSON.stringify(ev) + '\n');
    if (this.echo) console.log(summarize(ev));
    return ev;
  }

  async shot(surface: Surface, label: string): Promise<string> {
    const file = path.join('shots', `${String(this.seq).padStart(3, '0')}-${label.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40)}.png`);
    await surface.screenshot(path.join(this.dir, file));
    return file;
  }

  async failureBundle(surface: Surface, label: string): Promise<{ screenshot: string; snapshot: string }> {
    const screenshot = await this.shot(surface, `FAIL-${label}`);
    const snapshot = path.join('snapshots', `${String(this.seq).padStart(3, '0')}-${label.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40)}.html`);
    fs.mkdirSync(path.join(this.dir, 'snapshots'), { recursive: true });
    fs.writeFileSync(path.join(this.dir, snapshot), this.redactor.scrub(await surface.snapshot()));
    return { screenshot, snapshot };
  }

  writeJson(name: string, obj: unknown) {
    fs.mkdirSync(path.dirname(path.join(this.dir, name)), { recursive: true });
    fs.writeFileSync(path.join(this.dir, name), JSON.stringify(this.redactor.scrubDeep(obj), null, 2) + '\n');
  }
  writeText(name: string, text: string) {
    fs.mkdirSync(path.dirname(path.join(this.dir, name)), { recursive: true });
    fs.writeFileSync(path.join(this.dir, name), this.redactor.scrub(text));
  }

  close() {
    this.stream.end();
  }
}

function summarize(ev: RunEvent): string {
  const { t, seq, type, ...rest } = ev;
  const short = JSON.stringify(rest);
  return `[${String(seq).padStart(3, '0')}] ${type.padEnd(18)} ${short.length > 220 ? short.slice(0, 220) + '…' : short}`;
}

export function newRunId(prefix: string): string {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${prefix}-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}
