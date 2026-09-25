/**
 * The MCP Bridge, as this application reaches it.
 *
 * The agent never talks to a company system directly: this app has no route
 * to an MCP server, only to AgentBox's MCP Bridge, which checks that THIS
 * application holds a grant for THAT server and tool, holds sensitive actions
 * for an operator, and records every call. This module is the one place the
 * app speaks to it, and it turns the bridge's answers into one shape:
 *
 *   ok            the tool ran; `result` is the bridge's body
 *   held          the bridge created an approval request and did NOT run the
 *                 tool; `approvalId` names it. A held call never resumes by
 *                 itself -- after a manager approves, the same call is made again
 *   denied        the bridge refused: server or tool not granted, or identity
 *                 not accepted
 *   failed        no decision was reached -- unreachable, unparseable, the
 *                 approver behind it down, or the tool itself errored
 *   unconfigured  this container was given no bridge (the unprotected case)
 *
 * A 403 from the bridge is an ANSWER, not an outage, and the bridge says which
 * answer: `error_type: approval_required` with an `approval_id` is "waiting
 * for a person"; a bare 403 is "not allowed". The two must never be flattened.
 */

export const BRIDGE_URL_VAR = "MANAGED_MCP_BRIDGE_URL";
export const APP_TOKEN_VAR = "AGENTBOX_CUSTOM_APP_MCP_TOKEN";

const MAX_RESULT_CHARS = 6_000;

const REASONLESS_REFUSAL =
  "MCP Bridge refused this application's identity (HTTP 403) and gave no reason. " +
  "The most likely cause is that the target MCP server is not approved and bound " +
  "to this application yet - approve its tools and assign it to the application in " +
  "the admin console, then rebuild.";

export type BridgeStatus = "ok" | "held" | "denied" | "failed" | "unconfigured";

export interface BridgeOutcome {
  status: BridgeStatus;
  result?: Record<string, unknown>;
  error: string;
  approvalId: string;
  httpStatus: number;
}

export interface CatalogueEntry {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class BridgeUnconfigured extends Error {}

export function configuration(): { url: string; token: string } {
  const url = (process.env[BRIDGE_URL_VAR] ?? "").trim();
  if (!url) throw new BridgeUnconfigured(`${BRIDGE_URL_VAR} is not set`);
  const token = (process.env[APP_TOKEN_VAR] ?? "").trim();
  if (!token) throw new BridgeUnconfigured(`${APP_TOKEN_VAR} is not set`);
  return { url, token };
}

export function isConfigured(): boolean {
  try {
    configuration();
    return true;
  } catch {
    return false;
  }
}

async function request(
  method: string,
  path: string,
  body: Record<string, unknown> | null,
  timeoutMs: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { url, token } = configuration();
  const response = await fetch(`${url.replace(/\/+$/, "")}${path}`, {
    method,
    headers: { "content-type": "application/json", "X-AgentBox-App-Token": token },
    body: body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let parsed: unknown = {};
  try {
    parsed = await response.json();
  } catch {
    parsed = {};
  }
  const record =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { ok: false, error: "MCP Bridge answered with a non-object body" };
  return { status: response.status, body: record };
}

export async function callTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<BridgeOutcome> {
  let status: number;
  let body: Record<string, unknown>;
  try {
    ({ status, body } = await request("POST", "/call", { server, tool, arguments: args }, timeoutMs));
  } catch (error) {
    if (error instanceof BridgeUnconfigured) {
      return { status: "unconfigured", error: error.message, approvalId: "", httpStatus: 0 };
    }
    return { status: "failed", error: `MCP Bridge call failed: ${String((error as Error)?.message ?? error)}`, approvalId: "", httpStatus: 0 };
  }
  if (status === 200 && body.ok) {
    return { status: "ok", result: body, error: "", approvalId: "", httpStatus: status };
  }
  const error = String(body.error ?? "").trim();
  const errorType = String(body.error_type ?? "");
  const approvalId = String(body.approval_id ?? "");
  if (status === 403 && errorType === "approval_required") {
    return { status: "held", error, approvalId, httpStatus: status };
  }
  if (status === 403 && errorType === "approval_unavailable") {
    // Fail-closed, not a decision: the approver could not be reached and the
    // action stayed blocked. An outage, never a policy verdict.
    return { status: "failed", error, approvalId: "", httpStatus: status };
  }
  if (status === 401 || status === 403) {
    return { status: "denied", error: error || REASONLESS_REFUSAL, approvalId: "", httpStatus: status };
  }
  return {
    status: "failed",
    error: error || (Object.keys(body).length ? JSON.stringify(body) : `MCP Bridge answered HTTP ${status}`),
    approvalId: "",
    httpStatus: status,
  };
}

/** The tools the bridge grants this application, named `<server>__<tool>`, and
 * the servers it could not ask. Unconfigured lists nothing; unreachable is
 * reported through the second list rather than thrown. */
export async function listTools(
  timeoutMs = 20_000,
): Promise<{ tools: CatalogueEntry[]; unavailable: Array<{ server: string; reason: string }> }> {
  let status: number;
  let body: Record<string, unknown>;
  try {
    ({ status, body } = await request("GET", "/tools", null, timeoutMs));
  } catch (error) {
    if (error instanceof BridgeUnconfigured) return { tools: [], unavailable: [] };
    return { tools: [], unavailable: [{ server: "*", reason: `MCP Bridge unreachable: ${String((error as Error)?.message ?? error)}` }] };
  }
  if (status !== 200 || !body.ok) {
    return { tools: [], unavailable: [{ server: "*", reason: String(body.error ?? `MCP Bridge answered HTTP ${status}`) }] };
  }
  const tools = (Array.isArray(body.tools) ? body.tools : []).filter(
    (t): t is CatalogueEntry => Boolean(t) && typeof t === "object",
  );
  const unavailable = (Array.isArray(body.unavailable) ? body.unavailable : []).filter(
    (u): u is { server: string; reason: string } => Boolean(u) && typeof u === "object",
  );
  return { tools, unavailable };
}

/** `<server>__<tool>` back into its halves -- from the RIGHT, because a bundled
 * server is itself `<app>__<name>`. */
export function splitToolName(qualified: string): [string, string] {
  const at = qualified.lastIndexOf("__");
  if (at === -1) return ["", qualified];
  return [qualified.slice(0, at), qualified.slice(at + 2)];
}

/** What a successful call returned, as text for the model: MCP text blocks
 * joined, else the body serialised; bounded either way. */
export function resultText(result: unknown): string {
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    const content = record.content;
    if (Array.isArray(content)) {
      const texts = content
        .map((block) => (block && typeof block === "object" ? (block as { text?: unknown }).text : undefined))
        .filter((text): text is string => typeof text === "string");
      if (texts.length) return texts.join("\n").slice(0, MAX_RESULT_CHARS);
    }
    const trimmed = Object.fromEntries(Object.entries(record).filter(([key]) => !["ok", "server", "tool"].includes(key)));
    return JSON.stringify(trimmed).slice(0, MAX_RESULT_CHARS);
  }
  return String(result).slice(0, MAX_RESULT_CHARS);
}
