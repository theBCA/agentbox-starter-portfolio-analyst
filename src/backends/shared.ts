import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AnswerResult {
  answer: string;
  tool_calls: Array<Record<string, unknown>>;
}

/** One event from a backend's `runStream`, forwarded to the SSE response. */
export interface StreamEvent {
  type: "token" | "tool" | "tool_result" | "result";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  signal?: string;
  ok?: boolean;
  detail?: string;
  approval_id?: string;
  data?: Record<string, unknown>;
}

// The job the agent does is not written here. It comes from `concept/prompt.md`
// beside `src/` -- the concept is data, the code is the kit -- so the same
// backend can carry a different product by swapping that directory. Read once
// at import: the concept is source, not a cache. `dist/backends/` and
// `src/backends/` sit at the same depth, so one relative path serves both.
const CONCEPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "concept");
const FALLBACK_PROMPT =
  "You are this application's assistant. Answer the user's message directly and " +
  "briefly, use the tools you have when the request needs them, and relay every " +
  "tool result truthfully.";

export function loadConceptPrompt(): string {
  try {
    const text = readFileSync(path.join(CONCEPT_DIR, "prompt.md"), "utf8").trim();
    return text || FALLBACK_PROMPT;
  } catch {
    return FALLBACK_PROMPT;
  }
}

export const BASE_INSTRUCTIONS = loadConceptPrompt();

// The one thing this application is told about the environment it runs in:
// the absolute path of a file holding standing instructions for the agent.
//
// The whole contract is *read that file and append it to the system prompt*.
// It is optional in both directions -- an unset variable, a missing file and
// an empty file all mean "there are none", and the application then behaves
// exactly as one that was never given any. Nothing is parsed out of the file
// and nothing else is inferred from it.
export const SYSTEM_INSTRUCTIONS_VAR = "AGENTBOX_SYSTEM_INSTRUCTIONS";

// A bound, so a file that grew unexpectedly cannot crowd out the concept's
// own prompt or the conversation. Truncation is ANNOUNCED rather than silent:
// standing instructions the agent is expected to follow are the worst thing
// to drop the tail of without saying so.
const MAX_SYSTEM_INSTRUCTION_CHARS = 20000;
const TRUNCATION_NOTICE =
  `\n\n[The instructions above were truncated because they exceeded ` +
  `${MAX_SYSTEM_INSTRUCTION_CHARS} characters. Say so if you are asked to ` +
  `follow something that appears to be cut off.]`;

/**
 * The standing instructions this environment supplies, or `""`.
 *
 * Re-read on every request rather than cached at startup: the file may be
 * written, rewritten or removed while this application is running, and a copy
 * taken at import would be a copy of whichever happened first.
 *
 * Every failure answers `""` and says nothing -- no variable set, a path that
 * is not a readable file, an empty one. An application given none must behave
 * exactly as an application that was never offered any.
 */
export async function loadSystemInstructions(): Promise<string> {
  const configured = (process.env[SYSTEM_INSTRUCTIONS_VAR] ?? "").trim();
  if (!configured) return "";
  try {
    const text = (await readFile(configured, "utf8")).trim();
    if (text.length <= MAX_SYSTEM_INSTRUCTION_CHARS) return text;
    return text.slice(0, MAX_SYSTEM_INSTRUCTION_CHARS) + TRUNCATION_NOTICE;
  } catch {
    return "";
  }
}

/** The concept's prompt, then the standing instructions if there are any. */
export async function buildSystemInstructions(): Promise<string> {
  const standing = await loadSystemInstructions();
  return standing ? `${BASE_INSTRUCTIONS}\n\n${standing}` : BASE_INSTRUCTIONS;
}

/** The user turn: the input as written, and an optional question after it. */
export function buildUserText(userInput: string, question?: string | null): string {
  const text = userInput.trim();
  return question && question.trim() ? `${text}\n\nQuestion: ${question.trim()}` : text;
}
