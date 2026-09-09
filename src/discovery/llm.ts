/**
 * LLM boundary. The agent loop only knows about `decide(messages, tools) -> tool calls`, so the
 * provider is swappable and tests can run the whole loop with a scripted decider.
 */
import OpenAI from 'openai';

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema
}
export interface ToolCall {
  name: string;
  args: Record<string, any>;
}
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
export interface Decision {
  calls: ToolCall[];
  text?: string;
  usage?: { prompt: number; completion: number };
  model: string;
}

export interface LLM {
  readonly model: string;
  decide(messages: LLMMessage[], tools: ToolDef[], opts?: { forceTool?: boolean }): Promise<Decision>;
  /** Free-form JSON completion used once at the end of discovery to annotate the artifact. */
  json<T>(prompt: string, schemaHint: string): Promise<T>;
}

export class OpenAILLM implements LLM {
  private client: OpenAI;
  constructor(readonly model = process.env.HANDS_MODEL ?? 'gpt-4.1') {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set (see README: run with --llm scripted to run without it)');
    this.client = new OpenAI();
  }

  async decide(messages: LLMMessage[], tools: ToolDef[], opts: { forceTool?: boolean } = {}): Promise<Decision> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      messages,
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      // tool_choice: 'required' prevents the model from replying in prose instead of calling a
      // tool. A prose reply cannot be parsed into an action and would just waste a turn; the agent
      // loop enforces this by returning an error to the model when no tool call is present.
      tool_choice: opts.forceTool === false ? 'auto' : 'required',
      parallel_tool_calls: false,
    });
    const choice = res.choices[0];
    const calls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc: any) => ({
      name: tc.function.name,
      args: safeJson(tc.function.arguments),
    }));
    return {
      calls,
      text: choice.message.content ?? undefined,
      usage: res.usage ? { prompt: res.usage.prompt_tokens, completion: res.usage.completion_tokens } : undefined,
      model: res.model,
    };
  }

  async json<T>(prompt: string, schemaHint: string): Promise<T> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `Respond with a single JSON object matching this shape:\n${schemaHint}` },
        { role: 'user', content: prompt },
      ],
    });
    return safeJson(res.choices[0].message.content ?? '{}') as T;
  }
}

/** Deterministic stand-in: a script decides from the rendered observation. Used by tests and offline demos. */
export class ScriptedLLM implements LLM {
  readonly model = 'scripted';
  constructor(private script: (turn: { step: number; observation: string; lastResult?: string }) => ToolCall) {}
  private step = 0;
  async decide(messages: LLMMessage[]): Promise<Decision> {
    const last = messages[messages.length - 1];
    const call = this.script({ step: this.step++, observation: last.content });
    return { calls: [call], model: this.model };
  }
  async json<T>(): Promise<T> {
    return {} as T;
  }
}

function safeJson(s: string): Record<string, any> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
