import { readFileSync, statSync } from "node:fs";
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

// What the cached text was read from: path, mtime and size. A stat is what
// decides whether to re-read, so the ordinary request pays one `statSync` and
// no file read at all.
let instructionsSource: string | null = null;
let instructionsText = "";

/**
 * The standing instructions this environment supplies, or `""`.
 *
 * Called on EVERY request, and re-reads the file only when it has changed.
 *
 * It used to be called once at module load, on the reasoning that the file
 * describes an environment which does not change under a running application.
 * That was true when it was written and is not true now: the file carries the
 * list of skills this application currently holds, and AgentBox rewrites that
 * block IN PLACE on the running container's HOME volume whenever a skill is
 * granted or revoked -- deliberately, so that nothing has to be rebuilt or
 * restarted. `write_skill_index`'s own docstring ends "a running application
 * sees it on its next read". An application that read once at load has no
 * next read, so a skill granted to it stays invisible until somebody restarts
 * the process.
 *
 * A read that fails after a successful one keeps the last good text rather
 * than dropping to `""`: the file being briefly unreadable while it is
 * rewritten must not silently strip the agent's standing instructions for
 * that request.
 *
 * Every other failure answers `""` and says nothing -- no variable set, a path
 * that is not a readable file, an empty one. An application given none must
 * behave exactly as an application that was never offered any.
 */
export function loadSystemInstructions(): string {
  const configured = (process.env[SYSTEM_INSTRUCTIONS_VAR] ?? "").trim();
  if (!configured) {
    instructionsSource = null;
    instructionsText = "";
    return "";
  }

  let source: string;
  try {
    const stat = statSync(configured);
    source = `${configured}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    instructionsSource = null;
    instructionsText = "";
    return "";
  }

  if (source === instructionsSource) return instructionsText;

  let text: string;
  try {
    text = readFileSync(configured, "utf8").trim();
  } catch {
    return instructionsText;
  }

  if (text.length > MAX_SYSTEM_INSTRUCTION_CHARS) {
    text = text.slice(0, MAX_SYSTEM_INSTRUCTION_CHARS) + TRUNCATION_NOTICE;
  }
  instructionsSource = source;
  instructionsText = text;
  return text;
}

/**
 * The concept's prompt, then the standing instructions if there are any.
 *
 * Reads the instructions file on every call, which costs a `statSync` unless
 * it changed. The file is NOT static: it carries the skills this application
 * currently holds, and AgentBox rewrites that block under a running container
 * on every grant and revoke. Holding the text in a module constant read at
 * load -- which is what this did -- meant a granted skill never reached the
 * model until the process was restarted.
 *
 * Stays async although it does not await anything: every backend calls it as
 * one, and the shape is what the next backend will copy.
 */
export async function buildSystemInstructions(): Promise<string> {
  const standing = loadSystemInstructions();
  return standing ? `${BASE_INSTRUCTIONS}\n\n${standing}` : BASE_INSTRUCTIONS;
}

/** The user turn: the input as written, and an optional question after it. */
export function buildUserText(userInput: string, question?: string | null): string {
  const text = userInput.trim();
  return question && question.trim() ? `${text}\n\nQuestion: ${question.trim()}` : text;
}
