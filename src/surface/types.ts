/**
 * Surface abstraction.
 *
 * A Surface is anything the system can *perceive* (observe) and *act* on: a web page today, a
 * legacy frameset app, and, behind the same interface, a desktop application exposed through an
 * OS accessibility API. The discovery agent and the replay engine never touch Playwright directly;
 * they only see Observations, ObservedElements and TargetSpecs. That is the seam.
 *
 * The key design choice: element *targeting* is a pure function over ObservedElement records
 * (see locator.ts). The surface's job is to produce those records and to turn a matched record
 * back into something it can click. That makes the locator logic testable without a browser and
 * portable to any surface that can enumerate controls with a role, a name and a position.
 */

export type Role =
  | 'button'
  | 'link'
  | 'textbox'
  | 'password'
  | 'combobox'
  | 'checkbox'
  | 'radio'
  | 'cell'
  | 'heading'
  | 'text'
  | 'option'
  | 'other';

export interface Fingerprint {
  tag: string;
  role: Role;
  name: string;
  attrName?: string; // form control name attribute (txt1, sel1...) - generic but stable on legacy apps
  type?: string; // input type
  anchor?: string; // label text to the left/above in table layouts
}

export interface ObservedElement {
  ref: number; // index within this observation; also the handle key for the surface
  frame: string; // frame path, '' for top document; nested frames joined by '/'
  role: Role;
  name: string; // accessible name, best effort
  text: string; // visible text content (trimmed, truncated)
  anchor?: string; // nearest label-like text (previous cell / cell above), legacy-table heuristic
  tag: string;
  attrs: { name?: string; type?: string; value?: string; href?: string; placeholder?: string };
  cssPath: string; // structural path, last-resort locator
  bbox: { x: number; y: number; w: number; h: number };
  enabled: boolean;
  editable: boolean;
  options?: string[]; // for combobox
  /** For table cells: column header text and the other cells' text in the same row. */
  grid?: { colHeader?: string; rowCells: string[] };
}

export interface FrameInfo {
  path: string;
  name: string;
  url: string;
}

export interface DialogInfo {
  type: string;
  message: string;
  handledAs: 'accepted' | 'dismissed';
}

export interface Observation {
  at: string;
  url: string;
  title: string;
  frames: FrameInfo[];
  elements: ObservedElement[];
  /** Visible text of the page (all frames), truncated. Used for outcome detection and for the LLM. */
  text: string;
  /** Dialogs that fired since the previous observation. */
  dialogs: DialogInfo[];
}

/** How a recorded step finds its control at replay time. Ordered: first hit wins. */
export type LocatorStrategy =
  | { kind: 'role'; role: Role; name: string }
  | { kind: 'anchor'; anchor: string; role: Role }
  | { kind: 'text'; text: string; role?: Role }
  | { kind: 'grid'; row: string; column: string }
  | { kind: 'attr'; tag: string; name?: string; type?: string; value?: string }
  | { kind: 'css'; selector: string };

export interface TargetSpec {
  /** Human-readable description written at record time, e.g. `the "Member Number" text box`. */
  description: string;
  frame: { name?: string; urlPattern?: string };
  strategies: LocatorStrategy[];
  fingerprint: Fingerprint;
}

export type SurfaceAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; ref: number; acceptDialog?: boolean }
  | { kind: 'type'; ref: number; text: string; submit?: boolean }
  | { kind: 'select'; ref: number; option: string }
  | { kind: 'press'; key: string }
  | { kind: 'wait'; ms: number };

export interface Resolved {
  element: ObservedElement;
  strategyIndex: number; // which strategy matched
  strategy: LocatorStrategy;
  fingerprintScore: number; // 0..1
}

export interface Surface {
  readonly kind: 'web' | 'desktop';
  observe(): Promise<Observation>;
  /** Resolve a TargetSpec against the current state. Returns null if nothing matches acceptably. */
  resolve(target: TargetSpec): Promise<Resolved | null>;
  act(action: SurfaceAction): Promise<void>;
  /** Text content of a previously observed element (re-observes if needed). */
  readText(ref: number): Promise<string>;
  screenshot(path: string): Promise<void>;
  /** Rich failure evidence: serialized DOM/AX of every frame. */
  snapshot(): Promise<string>;
  currentUrl(): string;
  /** Wait for quiescence (no navigation in flight, documents loaded). Resolves false on timeout. */
  waitQuiescent(timeoutMs: number): Promise<boolean>;
  /** Pre-answer the next native dialog (who holds the session decides; unanswered dialogs are dismissed). */
  answerNextDialog(response: 'accept' | 'dismiss'): void;
  /** Human-control support: start/stop recording of raw user input on the live session. */
  startHumanCapture(onEvent: (e: HumanEvent) => void): Promise<void>;
  stopHumanCapture(): Promise<void>;
  close(): Promise<void>;
}

export interface HumanEvent {
  at: string;
  frame: string;
  kind: 'click' | 'input' | 'submit' | 'navigate' | 'dialog';
  target: string; // description of what was touched (never the value typed into password fields)
  value?: string;
}
