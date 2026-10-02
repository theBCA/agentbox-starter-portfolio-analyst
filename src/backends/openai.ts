/**
 * OpenAI Agents SDK backend.
 *
 * `OPENAI_BASE_URL`/`OPENAI_API_KEY` are read by the underlying client;
 * `configureSecureProxy` points them at SecureProxy before the agent starts,
 * so every model call is brokered and the app never holds a real key.
 *
 * Tools: the agent's toolkit (`src/agentTools.ts`) is handed to the SDK as
 * function tools whose parameters are the JSON schemas the bridge published,
 * so the model sees the same names, descriptions and parameters the Python
 * starters' models see. The stream emits the same events as those starters
 * (`token`, `tool`, `tool_result`, `result`) so the shared page reads all of
 * them with one code path.
 */

import { Agent, run as runAgent, tool } from "@openai/agents";
import { buildToolkit, outcomeEvent, TOOL_GUIDANCE, type Toolkit, type ToolOutcome } from "../agentTools.js";
import { buildSystemInstructions, buildUserText, type AnswerResult, type StreamEvent } from "./shared.js";
import { configureSecureProxy } from "./secureproxy.js";

const MAX_TURNS = 10;

function toolsFor(toolkit: Toolkit) {
  return toolkit.specs.map((spec) =>
    tool({
      name: spec.name,
      description: spec.description,
      // The schema arrives from the bridge as written by the server; it is
      // not necessarily strict-mode compliant, so strict is off and the
      // toolkit validates what it needs itself.
      parameters: spec.inputSchema as never,
      strict: false,
      execute: async (input: unknown) => {
        const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
        const { text } = await toolkit.run(spec.name, args);
        return text;
      },
    }),
  );
}

async function prepare(): Promise<{ agent: Agent; toolkit: Toolkit }> {
  configureSecureProxy("openai");
  const toolkit = await buildToolkit();
  const instructions =
    `${await buildSystemInstructions()}\n\n${TOOL_GUIDANCE}\n\n` +
    `Today's date in ISO 8601 format is ${new Date().toISOString().slice(0, 10)}.`;
  const agent = new Agent({
    name: "Portfolio Analyst",
    instructions,
    model: process.env.OPENAI_MODEL ?? "gpt-5.2",
    tools: toolsFor(toolkit),
  });
  return { agent, toolkit };
}

function deltaOf(data: unknown): string {
  const record = data as { delta?: unknown; choices?: Array<{ delta?: { content?: unknown } }> };
  if (typeof record?.delta === "string") return record.delta;
  const nested = (record?.delta as { text?: unknown } | undefined)?.text;
  if (typeof nested === "string") return nested;
  const choice = Array.isArray(record?.choices) ? record.choices[0] : undefined;
  if (typeof choice?.delta?.content === "string") return choice.delta.content;
  return "";
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { arguments: parsed };
    } catch {
      return { arguments: raw };
    }
  }
  return {};
}

interface StreamItem {
  type?: string;
  toolName?: unknown;
  output?: unknown;
  rawItem?: { name?: unknown; arguments?: unknown; callId?: unknown; call_id?: unknown; output?: unknown };
}

export async function* runStream(userInput: string, question: string | null): AsyncGenerator<StreamEvent> {
  const { agent, toolkit } = await prepare();
  const pending = new Map<string, string>();
  const stream = await runAgent(agent, buildUserText(userInput, question), { stream: true, maxTurns: MAX_TURNS });
  for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
    if (event.type === "raw_model_stream_event") {
      const text = deltaOf(event.data);
      if (text) yield { type: "token", text };
      continue;
    }
    if (event.type !== "run_item_stream_event") continue;
    const item = event.item as StreamItem | undefined;
    const raw = item?.rawItem ?? {};
    const callId = String(raw.callId ?? raw.call_id ?? "");
    if (item?.type === "tool_call_item") {
      const name = String(item.toolName ?? raw.name ?? "tool");
      if (callId) pending.set(callId, name);
      yield { type: "tool", id: callId, name, input: parseArguments(raw.arguments) };
    } else if (item?.type === "tool_call_output_item") {
      const name = pending.get(callId) ?? String(item.toolName ?? raw.name ?? "tool");
      pending.delete(callId);
      const recorded = toolkit.takeOutcome(name);
      const outcome: ToolOutcome = recorded ?? {
        name,
        signal: "tool_ok",
        ok: true,
        detail: String(item.output ?? raw.output ?? "").slice(0, 2000),
        approval_id: "",
        data: {},
      };
      yield { type: "tool_result", id: callId, ...outcomeEvent(outcome) };
    }
  }
  await stream.completed;
  if (stream.finalOutput != null && String(stream.finalOutput).trim()) {
    yield { type: "result", text: String(stream.finalOutput) };
  }
}

/** One answer plus what the agent did on the way -- built on the stream, so
 * the two cannot drift. */
export async function run(userInput: string, question: string | null): Promise<AnswerResult> {
  let final = "";
  const said: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  for await (const event of runStream(userInput, question)) {
    if (event.type === "result") final = String(event.text ?? "");
    else if (event.type === "token") said.push(String(event.text ?? ""));
    else if (event.type === "tool_result") {
      toolCalls.push({ name: event.name, signal: event.signal, ok: event.ok, detail: event.detail, approval_id: event.approval_id });
    }
  }
  const answer = final || said.join("");
  if (!answer.trim()) throw new Error("the agent returned no text");
  return { answer, tool_calls: toolCalls };
}
