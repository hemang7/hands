/**
 * Stretch demo: an AI agent answers a question by *invoking* a capability, never by driving the UI.
 * The model decides WHAT to call; the replay engine does it deterministically. This is the
 * production shape described in the brief: "the model discovers, the artifact becomes a reusable
 * capability, deterministic replay is how the AI agent invokes it".
 */
import OpenAI from 'openai';
import fs from 'node:fs';
import path from 'node:path';
import type { CapabilityStore } from '../artifact/store.js';
import { Catalog } from './catalog.js';

export async function runAgentDemo(store: CapabilityStore, question: string, opts: { tenant?: string; runsDir: string; model?: string }) {
  if (!process.env.OPENAI_API_KEY) throw new Error('agent demo needs OPENAI_API_KEY');
  const client = new OpenAI();
  const model = opts.model ?? process.env.HANDS_MODEL ?? 'gpt-4.1';
  const catalog = new Catalog(store);
  const tools = catalog.tools();
  const transcript: any[] = [];
  const messages: any[] = [
    {
      role: 'system',
      content:
        'You are a back-office assistant for a credit union. You cannot see or operate any screens yourself. To get information or perform work you call the provided capabilities, which run recorded automations against the core system. Treat a returned business outcome (e.g. RECORD_NOT_FOUND) as the answer, not as an error. Answer concisely and cite the capability run id.',
    },
    { role: 'user', content: question },
  ];
  console.log(`agent question: ${question}`);
  console.log(`tools available: ${tools.map((t) => t.function.name).join(', ')}`);
  for (let turn = 0; turn < 4; turn++) {
    const res = await client.chat.completions.create({ model, temperature: 0, messages, tools });
    const msg = res.choices[0].message;
    messages.push(msg);
    transcript.push({ turn, role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });
    if (!msg.tool_calls?.length) {
      console.log(`\nagent answer: ${msg.content}`);
      break;
    }
    for (const tc of msg.tool_calls as any[]) {
      const args = JSON.parse(tc.function.arguments || '{}');
      console.log(`agent -> invoke ${tc.function.name}(${JSON.stringify(args)})`);
      const result = await catalog.invoke(tc.function.name, args, { tenant: opts.tenant, runsDir: opts.runsDir });
      console.log(`invoke result: ${JSON.stringify(result)}`);
      transcript.push({ turn, role: 'tool', name: tc.function.name, args, result });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  const dir = path.join(opts.runsDir, `agent-demo-${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify({ question, model, tools: tools.map((t) => t.function.name), transcript }, null, 2));
  console.log(`transcript: ${dir}/transcript.json`);
}
