#!/usr/bin/env node
/**
 * hands CLI
 *
 *   discover  run the LLM against a goal on a live surface and record a capability
 *   replay    replay a capability deterministically with inputs; no model involved
 *   approve   mark a capability version as approved for unattended replay
 *   catalog   list capabilities as an agent-facing tool catalog
 *   invoke    call a capability by name with typed args (what an AI agent does in production)
 *   agent     stretch: let an LLM answer a question using the catalog as its tools
 *   learn-overrides  stretch: turn a replay's drift + handoff evidence into tenant overrides
 */

// Auto-load .env from the project root so the CLI works without manually running `source .env`.
// Uses Node's built-in env file support (Node 20.6+). Silent no-op if .env is absent.
try { (process as any).loadEnvFile(new URL('../.env', import.meta.url)); } catch {}

import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { CapabilityStore } from './artifact/store.js';
import { DiscoveryAgent } from './discovery/agent.js';
import { OpenAILLM, type LLM } from './discovery/llm.js';
import { memberLookupScript, openSubAccountScript } from './discovery/scripted.js';
import { Evidence, newRunId } from './evidence/evidence.js';
import { SessionController } from './handoff/control.js';
import { ConsoleOperator, HttpOperator, ScriptedOperator } from './handoff/operators.js';
import { SCENARIOS } from './handoff/scenarios.js';
import { PolicyEngine } from './policy/policy.js';
import { Redactor } from './policy/redact.js';
import { ReplayEngine } from './replay/engine.js';
import { exitCodeFor } from './replay/result.js';
import { PlaywrightSurface } from './surface/playwright.js';
import { Catalog } from './catalog/catalog.js';
import { proposeOverrides, withOverride } from './artifact/overrides.js';

const [cmd, ...rest] = process.argv.slice(2);

const { values: v, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    id: { type: 'string' },
    goal: { type: 'string' },
    input: { type: 'string', multiple: true, default: [] },
    pii: { type: 'string', multiple: true, default: [] },
    tenant: { type: 'string' },
    profile: { type: 'string', default: 'legacycore-teller' },
    llm: { type: 'string', default: process.env.OPENAI_API_KEY ? 'openai' : 'scripted' },
    model: { type: 'string' },
    headed: { type: 'boolean', default: false },
    'max-steps': { type: 'string', default: '25' },
    'allow-irreversible': { type: 'boolean', default: false },
    confirm: { type: 'boolean', default: false },
    inject: { type: 'string' },
    operator: { type: 'string', default: 'console' },
    'settle-ms': { type: 'string' },
    'intervention-timeout-ms': { type: 'string', default: '120000' },
    'runs-dir': { type: 'string', default: 'runs' },
    'run-id': { type: 'string' },
    quiet: { type: 'boolean', default: false },
    version: { type: 'string' },
    json: { type: 'boolean', default: false },
    'from-run': { type: 'string' },
  },
});

function parseInputs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of v.input ?? []) {
    const i = kv.indexOf('=');
    if (i < 0) throw new Error(`--input expects name=value, got "${kv}"`);
    out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

function makeRedactor(store: CapabilityStore, profileId: string): Redactor {
  const r = new Redactor();
  const profile = store.loadProfile(profileId);
  for (const env of Object.values(profile.secrets)) r.addSecret(process.env[env]);
  return r;
}

async function inject(mode: string | undefined, entryUrl: string, tenant: string) {
  if (!mode) return;
  const origin = new URL(entryUrl).origin;
  const res = await fetch(`${origin}/__chaos?tenant=${tenant}&set=${mode}`);
  console.log(`injected chaos "${mode}" on tenant ${tenant}: ${await res.text()}`);
}

async function main() {
  const store = new CapabilityStore();
  switch (cmd) {
    case 'discover':
      return discover(store);
    case 'replay':
      return replay(store);
    case 'approve': {
      const cap = store.load(positionals[0], v.version ? Number(v.version) : undefined);
      cap.status = 'approved';
      console.log(`approved ${cap.id} v${cap.version} -> ${store.save(cap)}`);
      return;
    }
    case 'catalog': {
      const cat = new Catalog(store);
      if (v.json) console.log(JSON.stringify(cat.tools(), null, 2));
      else for (const t of cat.describe()) console.log(t);
      return;
    }
    case 'learn-overrides': {
      // hands learn-overrides <capability> --from-run <runId>
      const cap = store.load(positionals[0], v.version ? Number(v.version) : undefined);
      const runDir = path.join(path.resolve(v['runs-dir']!), v['from-run']!);
      const result = JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'));
      const proposal = proposeOverrides(cap, result);
      const next = withOverride(cap, proposal);
      const file = store.save(next);
      console.log(`tenant "${proposal.tenant}" overrides proposed from run ${v['from-run']}:\n  ${proposal.notes.join('\n  ')}\n-> ${file} (v${next.version}, draft: review and approve)`);
      return;
    }
    case 'invoke':
      return invoke(store);
    case 'agent':
      return agentDemo(store);
    default:
      console.log(fs.readFileSync(new URL('./cli.ts', import.meta.url), 'utf8').split('\n').slice(2, 12).join('\n'));
      process.exit(1);
  }
}

async function discover(store: CapabilityStore) {
  if (!v.id || !v.goal) throw new Error('discover requires --id and --goal');
  const profile = store.loadProfile(v.profile!);
  const tenant = v.tenant ?? Object.keys(profile.tenants)[0];
  const entryUrl = profile.tenants[tenant].entryUrl;
  const inputs = parseInputs();
  const goalInputs: Record<string, { value: string; sensitivity: 'none' | 'pii' | 'secret' }> = {};
  for (const [k, val] of Object.entries(inputs)) goalInputs[k] = { value: val, sensitivity: v.pii!.includes(k) ? 'pii' : 'none' };
  const redactor = makeRedactor(store, v.profile!);
  for (const k of v.pii!) redactor.addPii(inputs[k]);
  const evidence = new Evidence(v['run-id'] ?? newRunId('discovery'), redactor, path.resolve(v['runs-dir']!), !v.quiet);
  const llm: LLM = v.llm === 'openai' ? new OpenAILLM(v.model) : v.id === 'open_sub_account' ? openSubAccountScript(inputs) : memberLookupScript(inputs.memberId ?? '');
  const surface = await PlaywrightSurface.launch({ headless: !v.headed, settleTimeoutMs: v['settle-ms'] ? Number(v['settle-ms']) : undefined });
  const control = new SessionController(surface, [new ConsoleOperator()], Number(v['intervention-timeout-ms']));
  await attachOperator(control, surface);
  const policy = new PolicyEngine({
    allowlist: { origins: [new URL(entryUrl).origin], routes: [], actions: ['navigate', 'click', 'type', 'select', 'extract'] },
    irreversibleControlPattern: profile.irreversibleControlPattern,
  });
  const agent = new DiscoveryAgent(surface, llm, policy, evidence, control);
  try {
    const result = await agent.run({
      capabilityId: v.id,
      goal: { goal: v.goal, inputs: goalInputs, secretRefs: Object.keys(profile.secrets), allowIrreversible: v['allow-irreversible']! },
      entryUrl,
      profile,
      tenant,
      maxSteps: Number(v['max-steps']),
    });
    if (result.status === 'success') {
      const existing = store.list().filter((c) => c.id === result.capability.id);
      if (existing.length) result.capability.version = Math.max(...existing.map((c) => c.version)) + 1;
      const file = store.save(redactor.scrubDeep(result.capability)); // defense in depth: no secret/pii value survives into the artifact
      evidence.writeJson('capability.json', result.capability);
      evidence.writeJson('result.json', { status: 'success', steps: result.steps, summary: result.summary, capabilityFile: file });
      console.log(`\nDISCOVERY SUCCEEDED in ${result.steps} steps -> ${file}\nevidence: ${evidence.dir}`);
    } else {
      evidence.writeJson('result.json', result);
      console.log(`\nDISCOVERY STOPPED: ${result.reason}\nevidence: ${evidence.dir}`);
      process.exitCode = 2;
    }
  } finally {
    evidence.close();
    await surface.close();
    await stopOperator();
  }
}

let httpOp: HttpOperator | null = null;
async function attachOperator(control: SessionController, surface: PlaywrightSurface) {
  const spec = v.operator ?? 'console';
  if (spec === 'http') {
    httpOp = new HttpOperator();
    await httpOp.start(control);
    control.addOperator(httpOp);
  } else if (spec.startsWith('scripted:')) {
    const name = spec.slice('scripted:'.length);
    const human = SCENARIOS[name];
    if (!human) throw new Error(`unknown scripted operator scenario "${name}" (have: ${Object.keys(SCENARIOS).join(', ')})`);
    control.addOperator(new ScriptedOperator(surface.page, human));
  }
}
async function stopOperator() {
  await httpOp?.stop();
}

async function replay(store: CapabilityStore) {
  const cap = store.load(positionals[0], v.version ? Number(v.version) : undefined);
  const profile = store.loadProfile(cap.app.profile);
  const tenant = v.tenant ?? cap.provenance.tenant ?? Object.keys(profile.tenants)[0];
  const entryUrl = cap.tenants?.[tenant]?.entryUrl ?? profile.tenants[tenant]?.entryUrl ?? cap.app.entryUrl;
  const redactor = makeRedactor(store, cap.app.profile);
  const evidence = new Evidence(v['run-id'] ?? newRunId(`replay-${cap.id}`), redactor, path.resolve(v['runs-dir']!), !v.quiet);
  await inject(v.inject, entryUrl, tenant);
  const surface = await PlaywrightSurface.launch({ headless: !v.headed, settleTimeoutMs: v['settle-ms'] ? Number(v['settle-ms']) : undefined });
  const control = new SessionController(surface, [new ConsoleOperator()], Number(v['intervention-timeout-ms']));
  await attachOperator(control, surface);
  const engine = new ReplayEngine(surface, store, evidence, control, redactor);
  try {
    const result = await engine.run({ capability: cap, inputs: parseInputs(), tenant, confirm: v.confirm });
    evidence.writeJson('result.json', result);
    printResult(redactor.scrubDeep(result)); // the console is an output channel too
    process.exitCode = exitCodeFor(result);
  } finally {
    evidence.close();
    await surface.close();
    await stopOperator();
  }
}

async function invoke(store: CapabilityStore) {
  const cat = new Catalog(store);
  const evidenceRoot = path.resolve(v['runs-dir']!);
  const result = await cat.invoke(positionals[0], parseInputs(), { tenant: v.tenant, confirm: v.confirm, headed: v.headed, runsDir: evidenceRoot });
  console.log(JSON.stringify(result, null, 2));
}

async function agentDemo(store: CapabilityStore) {
  const question = positionals.join(' ');
  if (!question) throw new Error('agent requires a question, e.g. hands agent "What is the savings balance of member 10001?"');
  const { runAgentDemo } = await import('./catalog/agent-demo.js');
  await runAgentDemo(store, question, { tenant: v.tenant, runsDir: path.resolve(v['runs-dir']!), model: v.model });
}

function printResult(r: any) {
  const line = '-'.repeat(78);
  console.log(`\n${line}\nREPLAY ${r.status.toUpperCase()}  ${r.capability.id} v${r.capability.version} (${r.capability.status}) on tenant ${r.tenant}  ${r.durationMs}ms\n${line}`);
  if (r.status === 'success') console.log('outputs:', JSON.stringify(r.outputs));
  if (r.status === 'outcome') console.log(`business outcome ${r.outcome.code} at ${r.outcome.atStep}: "${r.outcome.message}"`);
  if (r.status === 'failed' || r.status === 'escalated') {
    console.log(`failure ${r.failure.code}${r.failure.stepId ? ` at ${r.failure.stepId}` : ''}: ${r.failure.message}`);
    if (r.failure.expected) console.log(`  expected: ${r.failure.expected}`);
    if (r.failure.observed) console.log(`  observed: ${String(r.failure.observed).slice(0, 300)}`);
    if (r.failure.evidence) console.log(`  evidence: ${JSON.stringify(r.failure.evidence)}`);
  }
  console.log('steps:');
  for (const s of r.steps) console.log(`  ${s.status.padEnd(16)} ${s.id.padEnd(14)} ${s.kind.padEnd(9)} ${(s.strategyUsed ?? '').padEnd(22)} x${s.attempts} ${s.durationMs}ms${s.note ? '  ' + s.note : ''}`);
  if (r.drift.length) console.log('drift warnings:\n' + r.drift.map((d: any) => `  ${d.message}`).join('\n'));
  if (r.recoveries.length) console.log('recoveries:\n' + r.recoveries.map((d: any) => `  ${d.stepId} ${d.code}: ${d.action} (${d.succeeded ? 'ok' : 'failed'})`).join('\n'));
  if (r.interventions.length) console.log('interventions:\n' + r.interventions.map((d: any) => `  ${d.id} at ${d.stepId} (${d.cause}) -> ${d.operator} chose ${d.action}: "${d.note}"; ${d.humanActions.length} human actions recorded`).join('\n'));
  console.log(`evidence: ${r.evidenceDir}\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
