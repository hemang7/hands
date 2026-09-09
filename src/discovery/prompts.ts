import type { Observation, ObservedElement } from '../surface/types.js';
import type { ToolDef } from './llm.js';

export const TOOLS: ToolDef[] = [
  {
    name: 'click',
    description: 'Click an element by its [ref]. If the control commits an irreversible change (Confirm/Post/Transfer) you must set confirmIrreversible=true and it will only proceed if the run permits it.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'integer' },
        reason: { type: 'string', description: 'Why this element, in one sentence. Recorded into the artifact for reviewers.' },
        confirmIrreversible: { type: 'boolean' },
        acceptDialog: { type: 'boolean', description: 'Accept a native confirm() dialog if one appears. Only after a previous click reported a dismissed dialog.' },
      },
      required: ['ref', 'reason'],
    },
  },
  {
    name: 'type',
    description: 'Type into a text field by [ref]. Provide either text (for values you can see, e.g. an input value from the goal) or secretRef (the name of a provided secret; its value is filled for you and never shown).',
    parameters: {
      type: 'object',
      properties: { ref: { type: 'integer' }, text: { type: 'string' }, secretRef: { type: 'string' }, reason: { type: 'string' } },
      required: ['ref', 'reason'],
    },
  },
  {
    name: 'select',
    description: 'Choose an option (by visible label) in a dropdown by [ref].',
    parameters: { type: 'object', properties: { ref: { type: 'integer' }, option: { type: 'string' }, reason: { type: 'string' } }, required: ['ref', 'option', 'reason'] },
  },
  {
    name: 'extract',
    description: 'Declare an output of this capability: the value shown in element [ref] is what the caller wants back. Use a snake_case name and a type.',
    parameters: {
      type: 'object',
      properties: { ref: { type: 'integer' }, name: { type: 'string' }, type: { type: 'string', enum: ['string', 'number', 'money', 'boolean'] }, reason: { type: 'string' } },
      required: ['ref', 'name', 'type', 'reason'],
    },
  },
  {
    name: 'declare_outcome',
    description: 'You reached a legitimate business result that is NOT the goal (e.g. "no such member", "insufficient privileges"). Record it so replays can report it, then call done_with_outcome or continue if the goal is still reachable.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'UPPER_SNAKE code, e.g. RECORD_NOT_FOUND' },
        textPresent: { type: 'string', description: 'Exact visible text that identifies this outcome (no ids, amounts or dates).' },
        description: { type: 'string' },
      },
      required: ['code', 'textPresent', 'description'],
    },
  },
  {
    name: 'done',
    description: 'The goal is fully met and all requested outputs have been extracted. evidenceText must be exact visible text on the current screen that proves it (a heading or label, not a number).',
    parameters: { type: 'object', properties: { summary: { type: 'string' }, evidenceText: { type: 'string' } }, required: ['summary', 'evidenceText'] },
  },
  {
    name: 'stuck',
    description: 'You cannot safely make progress (missing information, blocked, unexpected state, or the goal is impossible). A human operator will be asked to intervene.',
    parameters: { type: 'object', properties: { reason: { type: 'string' }, needed: { type: 'string', description: 'What the human should do or decide.' } }, required: ['reason', 'needed'] },
  },
];

export interface GoalSpec {
  goal: string;
  inputs: Record<string, { value: string; sensitivity: 'none' | 'pii' | 'secret' }>;
  secretRefs: string[];
  allowIrreversible: boolean;
}

export function systemPrompt(g: GoalSpec): string {
  const inputs = Object.entries(g.inputs)
    .map(([k, v]) => `  - ${k} = "${v.value}"${v.sensitivity !== 'none' ? ` (${v.sensitivity})` : ''}`)
    .join('\n');
  return `You are operating a legacy back-office banking application through a text rendering of its screen, one action per turn.

GOAL: ${g.goal}

INPUTS you may type verbatim where the goal needs them:
${inputs || '  (none)'}

SECRETS available by reference only (use type with secretRef; you never see the values):
${g.secretRefs.map((s) => `  - ${s}`).join('\n') || '  (none)'}

RULES
- You see the screen as a list of elements, each with a [ref] number, a role, an accessible name, the frame it lives in, and for table cells the text of its row/column context. Act only on refs from the CURRENT observation.
- Take the shortest reasonable path. One tool call per turn. Read the screen after each action; do not assume a click worked.
- Legacy apps use table layouts: an input's label is usually the text in the cell to its left. Menus live in a separate frame.
- Use extract for every value the goal asks you to read, choosing the cell that holds the value itself (not its label). Name outputs in snake_case.
- If the app shows a legitimate non-success result (record not found, validation message, permission denied), call declare_outcome with the exact identifying text, then decide whether the goal is still reachable.
- ${g.allowIrreversible ? 'Irreversible actions (Confirm/Post) are permitted for this run but you MUST pass confirmIrreversible=true and only after a review screen shows the exact intended values.' : 'Do NOT commit irreversible actions (Confirm/Post/Transfer). If the goal stops at a review or confirmation screen, stop there and call done.'}
- If a native dialog was dismissed after your click, the observation will say so; re-click with acceptDialog=true only if accepting it is required by the goal and permitted.
- When the goal is met, call done with an evidenceText that is exact, stable text visible on the final screen (a heading such as "MEMBER DETAIL", never a balance or id).
- If you cannot proceed safely, call stuck.`;
}

export function renderObservation(obs: Observation, extra: { detected?: string[]; lastResult?: string; step: number; maxSteps: number }): string {
  const lines: string[] = [];
  lines.push(`STEP ${extra.step}/${extra.maxSteps}`);
  if (extra.lastResult) lines.push(`LAST ACTION RESULT: ${extra.lastResult}`);
  if (extra.detected?.length) lines.push(`DETECTED CONDITIONS: ${extra.detected.join(', ')}`);
  lines.push(`URL: ${obs.url}`);
  lines.push(`TITLE: ${obs.title}`);
  if (obs.frames.length > 1) lines.push(`FRAMES: ${obs.frames.map((f) => `${f.name || 'top'} -> ${f.url}`).join(' | ')}`);
  if (obs.dialogs.length) lines.push(`DIALOGS SINCE LAST ACTION: ${obs.dialogs.map((d) => `${d.type} "${d.message}" was ${d.handledAs}`).join('; ')}`);
  lines.push('ELEMENTS:');
  for (const e of obs.elements) {
    if (!isWorthShowing(e)) continue;
    lines.push('  ' + renderElement(e));
  }
  lines.push('VISIBLE TEXT (truncated):');
  lines.push('  ' + obs.text.replace(/\n/g, '\n  ').slice(0, 2500));
  return lines.join('\n');
}

function isWorthShowing(e: ObservedElement): boolean {
  if (e.editable || e.role === 'button' || e.role === 'link') return true;
  return !!e.text && e.text.length <= 120;
}

export function renderElement(e: ObservedElement): string {
  const bits: string[] = [`[${e.ref}]`, e.role, JSON.stringify(e.name || e.text || '')];
  if (e.frame) bits.push(`frame=${e.frame}`);
  if (e.editable && e.attrs.value) bits.push(`value=${JSON.stringify(e.attrs.value)}`);
  if (e.anchor && e.anchor !== e.name) bits.push(`label=${JSON.stringify(e.anchor)}`);
  if (e.options) bits.push(`options=${JSON.stringify(e.options)}`);
  if (e.grid?.colHeader) bits.push(`column=${JSON.stringify(e.grid.colHeader)} row=${JSON.stringify(e.grid.rowCells.slice(0, 3))}`);
  if (!e.enabled) bits.push('disabled');
  return bits.join(' ');
}
