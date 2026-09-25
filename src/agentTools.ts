/**
 * What the agent can do, and what each attempt is reported as.
 *
 * Three kinds of tool, one toolkit per request: the company systems the
 * bridge grants this application (read from `GET /tools` at request time,
 * called through `POST /call` -- nothing here knows which systems those are);
 * `post_to_site` and `read_web_page` (out through SecureProxy's forward proxy
 * when there is one); `install_package` (`npm install` through Package
 * Guard's shim when there is one); `keep_note` (a file in the agent's own
 * notes, which the file guard watches from outside the container);
 * `list_files` and `read_file` (a READ-ONLY look at the agent's own HOME --
 * generic on purpose: this application knows nothing about where the platform
 * keeps anything. Its standing instructions say where to look, the reviewed
 * skills for one, and these are how the agent follows them; the Agents SDK
 * has no file tool of its own).
 *
 * Every attempt ends in a ToolOutcome carrying a SIGNAL from a fixed
 * vocabulary, derived from what came back -- the bridge's body, the proxy's
 * status, the guard's verdict, the note vanishing -- never from what was
 * asked. The page turns a signal into one plain sentence; the model gets the
 * text, which tells it what NOT to do next (a held action has not run and
 * must not be retried; a refusal is relayed, not worked around).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as bridge from "./bridge.js";
import { installPackage, probeEgress } from "./demos.js";
import { fetchThroughProxy, postThroughProxy, proxyConfiguration } from "./egress.js";

export const SIGNALS = new Set([
  "tool_ok",
  "tool_held",
  "tool_denied",
  "egress_ok",
  "egress_blocked",
  "pkg_allow",
  "pkg_block",
  "pkg_hold",
  "note_quarantined",
  "note_kept",
  "failed",
]);

export const POST_TO_SITE = "post_to_site";
export const READ_WEB_PAGE = "read_web_page";
export const INSTALL_PACKAGE = "install_package";
export const KEEP_NOTE = "keep_note";
export const LIST_FILES = "list_files";
export const READ_FILE = "read_file";

// Bounds on one file-tool answer, so a directory tree or a large file cannot
// crowd the conversation out of the model's context.
const MAX_LISTED_FILES = 200;
const MAX_READ_BYTES = 64 * 1024;

export const TOOL_GUIDANCE =
  "You have tools. The ones named after the company's systems read or change real " +
  "records; post_to_site sends text to a website and read_web_page " +
  "fetches one; install_package adds software to this application; keep_note saves " +
  "a note in your own files; list_files and read_file show you files under your " +
  "home directory, read-only -- use them to follow your standing instructions, " +
  "for instance to read the skills they point you to. Use a tool when the request needs one and not " +
  "otherwise, and say in one short sentence what you are about to do before you " +
  "call it. Read every tool result before answering. If it says the action is " +
  "waiting for a manager's approval, tell the user it is waiting and stop: do not " +
  "try again and do not say it happened. If it says the action was refused, or a " +
  "site is not on the list, or a package was refused, relay that plainly. If it " +
  "says something failed, say so in the words you were given. Never describe a " +
  "result a tool did not return.";

const NOTE_WATCH_MS = 8_000;
const MAX_DETAIL_CHARS = 2_000;
const TOOL_NAME_RE = /[^A-Za-z0-9_-]+/g;
const SERVER_PREFIX_RE = /^\[[^\]]*\]\s*/;

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  kind: "bridge" | "egress" | "package" | "note" | "files";
  server?: string;
  tool?: string;
}

export interface ToolOutcome {
  name: string;
  signal: string;
  ok: boolean;
  detail: string;
  approval_id: string;
  data: Record<string, unknown>;
}

export function outcomeEvent(o: ToolOutcome): Record<string, unknown> {
  return { name: o.name, signal: o.signal, ok: o.ok, detail: o.detail.slice(0, MAX_DETAIL_CHARS), approval_id: o.approval_id, data: { ...o.data } };
}

function outcome(name: string, signal: string, ok: boolean, detail: string, data: Record<string, unknown> = {}, approvalId = ""): ToolOutcome {
  return { name, signal, ok, detail, approval_id: approvalId, data };
}

const FIXED_SPECS: ToolSpec[] = [
  {
    name: POST_TO_SITE,
    description:
      "Send text to a web address outside the company, as an HTTP POST. Use it only when asked to post, publish or send something to a website. The result says whether the site could be reached and what it answered.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The full address, starting with https:// or http://" },
        text: { type: "string", description: "What to send" },
      },
      required: ["url", "text"],
      additionalProperties: false,
    },
    kind: "egress",
  },
  {
    name: READ_WEB_PAGE,
    description:
      "Fetch a web page or a data file from an address outside the company, as an HTTP GET. Use it only when asked for something that lives on a website, such as today's prices. The result is the page's text, or the reason it could not be reached.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "The full address, starting with https:// or http://" } },
      required: ["url"],
      additionalProperties: false,
    },
    kind: "egress",
  },
  {
    name: KEEP_NOTE,
    description:
      "Save a short note in your own notes, for the next time you look at this matter. Use it only when asked to note or remember something. The result says whether the note is there.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "A short file-safe title" },
        text: { type: "string", description: "The note" },
      },
      required: ["title", "text"],
      additionalProperties: false,
    },
    kind: "note",
  },
  {
    name: INSTALL_PACKAGE,
    description:
      "Add an npm package to this application. Use it only when asked to add software. The result says whether it was installed, refused, or is waiting for an operator's decision.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The package name, optionally with a version such as name@1.2.3" } },
      required: ["name"],
      additionalProperties: false,
    },
    kind: "package",
  },
  {
    name: LIST_FILES,
    description:
      "List the files under a directory in your home directory, however deep. Read-only. Use it to see what is there before reading a file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "An absolute path, or one relative to your home" } },
      required: ["path"],
      additionalProperties: false,
    },
    kind: "files",
  },
  {
    name: READ_FILE,
    description:
      "Read one text file under your home directory. Read-only. The result is the file's text, or the reason it could not be read.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "An absolute path, or one relative to your home" } },
      required: ["path"],
      additionalProperties: false,
    },
    kind: "files",
  },
];

export class Toolkit {
  readonly specs: ToolSpec[];
  readonly unavailable: Array<{ server: string; reason: string }>;
  private readonly byName = new Map<string, ToolSpec>();
  private readonly outcomes = new Map<string, ToolOutcome[]>();

  constructor(specs: ToolSpec[], unavailable: Array<{ server: string; reason: string }> = []) {
    this.specs = [...specs];
    this.unavailable = [...unavailable];
    for (const spec of this.specs) this.byName.set(spec.name, spec);
  }

  spec(name: string): ToolSpec | undefined {
    return this.byName.get(name);
  }

  /** Run one tool: the text for the model, and the outcome for the page,
   * kept so the stream can attach it to the SDK's output item later. */
  async run(name: string, args: Record<string, unknown>): Promise<{ text: string; outcome: ToolOutcome }> {
    const spec = this.byName.get(name);
    let result: ToolOutcome;
    if (!spec) result = outcome(name, "failed", false, `${JSON.stringify(name)} is not one of this application's tools`);
    else if (spec.kind === "bridge") result = await runBridgeTool(spec, args);
    else if (spec.kind === "egress") result = await runOutbound(spec, args);
    else if (spec.kind === "note") result = await runKeepNote(spec, args);
    else if (spec.kind === "files") result = runFileTool(spec, args);
    else result = await runInstall(spec, args);
    const queue = this.outcomes.get(name) ?? [];
    queue.push(result);
    this.outcomes.set(name, queue);
    return { text: modelText(result), outcome: result };
  }

  /** The oldest outcome of `name` not yet handed out. SIMPLIFIED: matched by
   * name in call order -- exact for the sequential calls an agent makes. */
  takeOutcome(name: string): ToolOutcome | undefined {
    const queue = this.outcomes.get(name);
    return queue?.shift();
  }
}

/** One toolkit for one request. Rebuilt every time: the grant can change
 * between requests, and a cached catalogue would keep offering yesterday's
 * tools. SIMPLIFIED: one GET /tools per request. */
export async function buildToolkit(): Promise<Toolkit> {
  const specs: ToolSpec[] = [...FIXED_SPECS];
  const taken = new Set(specs.map((s) => s.name));
  const { tools, unavailable } = await bridge.listTools();
  for (const entry of tools) {
    const [server, tool] = bridge.splitToolName(String(entry.name ?? ""));
    if (!server || !tool) continue;
    const name = modelName(tool, server, taken);
    taken.add(name);
    const schema = entry.inputSchema;
    specs.push({
      name,
      description: plainDescription(entry.description),
      inputSchema: schema && typeof schema === "object" && Object.keys(schema).length ? schema : { type: "object", properties: {} },
      kind: "bridge",
      server,
      tool,
    });
  }
  return new Toolkit(specs, unavailable);
}

function modelName(tool: string, server: string, taken: Set<string>): string {
  const base = tool.replace(TOOL_NAME_RE, "_").slice(0, 64) || "tool";
  if (!taken.has(base)) return base;
  const short = server.slice(server.lastIndexOf("__") + 2) || server;
  const prefixed = `${short}__${tool}`.replace(TOOL_NAME_RE, "_").slice(0, 64);
  let candidate = prefixed;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${prefixed.slice(0, 61)}_${n}`;
  return candidate;
}

function plainDescription(raw: unknown): string {
  const text = String(raw ?? "").replace(SERVER_PREFIX_RE, "").trim();
  return text || "A tool of one of the company's systems.";
}

async function runBridgeTool(spec: ToolSpec, args: Record<string, unknown>): Promise<ToolOutcome> {
  const answer = await bridge.callTool(spec.server ?? "", spec.tool ?? "", args);
  const data = { server: spec.server, tool: spec.tool, http_status: answer.httpStatus };
  if (answer.status === "ok") return outcome(spec.name, "tool_ok", true, bridge.resultText(answer.result), data);
  if (answer.status === "held") return outcome(spec.name, "tool_held", false, answer.error, data, answer.approvalId);
  if (answer.status === "denied") return outcome(spec.name, "tool_denied", false, answer.error, data);
  return outcome(spec.name, "failed", false, answer.error, data);
}

function httpsProxySet(): boolean {
  const configured = proxyConfiguration();
  return Boolean(configured.HTTPS_PROXY || configured.https_proxy);
}

async function runOutbound(spec: ToolSpec, args: Record<string, unknown>): Promise<ToolOutcome> {
  const url = String(args.url ?? "").trim();
  const text = String(args.text ?? "");
  const reading = spec.name === READ_WEB_PAGE;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return outcome(spec.name, "failed", false, "url must be a full http:// or https:// address");
  }
  if (!["http:", "https:"].includes(target.protocol) || !target.hostname) {
    return outcome(spec.name, "failed", false, "url must be a full http:// or https:// address");
  }
  const host = target.hostname;
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const proxied = httpsProxySet();
  const data: Record<string, unknown> = { host, port, proxied };

  if (proxied) {
    // Ask the proxy first with the raw CONNECT that keeps its own status line:
    // a refused tunnel is the decision this tool exists to report, and it has
    // to stay distinct from "the site is down".
    let probe: { status: number; reason: string };
    try {
      probe = await probeEgress(host, port);
    } catch (error) {
      return outcome(spec.name, "failed", false, String((error as Error)?.message ?? error), data);
    }
    data.proxy_status = probe.status;
    if (probe.status === 403) {
      return outcome(spec.name, "egress_blocked", false, `${host} is not on this application's list of allowed sites; nothing was sent or read`, data);
    }
    if (probe.status !== 200) {
      return outcome(spec.name, "failed", false, `the outbound proxy did not open a tunnel to ${host}: ${probe.reason || probe.status}`, data);
    }
  }

  let sent: { status: number; body_prefix?: string };
  try {
    if (proxied) sent = reading ? await fetchThroughProxy(url) : await postThroughProxy(url, text);
    else {
      const response = await fetch(url, reading ? { signal: AbortSignal.timeout(20_000) } : { method: "POST", body: text, headers: { "content-type": "text/plain; charset=utf-8" }, signal: AbortSignal.timeout(20_000) });
      sent = { status: response.status, body_prefix: (await response.text()).slice(0, 200) };
    }
  } catch (error) {
    return outcome(spec.name, "failed", false, `could not ${reading ? "read" : "send to"} ${host}: ${String((error as Error)?.message ?? error)}`, data);
  }
  data.status = sent.status;
  data.verb = reading ? "read" : "sent";
  const detail = reading ? `read ${host} (HTTP ${sent.status}):\n${sent.body_prefix ?? ""}` : `sent to ${host}; it answered HTTP ${sent.status}`;
  return outcome(spec.name, "egress_ok", true, detail, data);
}

async function runKeepNote(spec: ToolSpec, args: Record<string, unknown>): Promise<ToolOutcome> {
  const title = String(args.title ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60) || "note";
  const text = String(args.text ?? "");
  const configured = (process.env.AGENTBOX_AGENTIC_FILES_PATH ?? "").trim();
  const watched = Boolean(configured);
  const base = configured || path.join(os.homedir(), "notes");
  const target = path.join(base, "notes", `${title}.md`);
  const data: Record<string, unknown> = { path: target, watched };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, "utf8");
  } catch (error) {
    return outcome(spec.name, "failed", false, `could not write the note: ${String((error as Error)?.message ?? error)}`, data);
  }
  if (watched) {
    // The guard acts from OUTSIDE the container; the only signal in here is
    // that the file is gone. Gone means quarantined, still there means kept.
    const deadline = Date.now() + NOTE_WATCH_MS;
    while (Date.now() < deadline) {
      if (!fs.existsSync(target)) {
        return outcome(spec.name, "note_quarantined", false, "the note was moved to quarantine seconds after it was written", data);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return outcome(spec.name, "note_kept", true, `the note is kept at ${path.basename(target)}`, data);
}

/** `raw` resolved against HOME, refused if it lands outside it. Resolved
 * BEFORE the check (realpath), so `..` and a symlink pointing out of HOME are
 * judged by where they lead, not by how they are spelled. */
export function insideHome(raw: string): string {
  const home = fs.realpathSync(os.homedir());
  const expanded = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
  const candidate = !raw ? home : path.isAbsolute(expanded) ? expanded : path.join(home, expanded);
  const resolved = fs.realpathSync(candidate);
  if (resolved !== home && !resolved.startsWith(home + path.sep)) {
    throw new Error(`${JSON.stringify(raw)} is outside your home directory`);
  }
  return resolved;
}

function listFiles(dir: string, found: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (found.length > MAX_LISTED_FILES) return; // stop walking a large tree
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, found);
    else if (entry.isFile()) found.push(full);
  }
}

/** `list_files` / `read_file`: a read-only look at the agent's own HOME. */
export function runFileTool(spec: ToolSpec, args: Record<string, unknown>): ToolOutcome {
  const raw = String(args.path ?? "").trim();
  const data: Record<string, unknown> = { path: raw };
  let target: string;
  try {
    target = insideHome(raw);
  } catch (error) {
    return outcome(spec.name, "failed", false, String((error as Error)?.message ?? error), data);
  }
  try {
    if (spec.name === LIST_FILES) {
      if (!fs.statSync(target).isDirectory()) return outcome(spec.name, "failed", false, `${JSON.stringify(raw)} is not a directory`, data);
      const found: string[] = [];
      listFiles(target, found);
      const shown = found.slice(0, MAX_LISTED_FILES);
      let text = shown.length ? shown.join("\n") : "(no files)";
      if (found.length > shown.length) text += `\n... more than ${MAX_LISTED_FILES} files; list a subdirectory`;
      return outcome(spec.name, "tool_ok", true, text, data);
    }
    if (!fs.statSync(target).isFile()) return outcome(spec.name, "failed", false, `${JSON.stringify(raw)} is not a file`, data);
    const handle = fs.openSync(target, "r");
    const buffer = Buffer.alloc(MAX_READ_BYTES + 1);
    let read = 0;
    try {
      read = fs.readSync(handle, buffer, 0, buffer.length, 0);
    } finally {
      fs.closeSync(handle);
    }
    let text = buffer.subarray(0, Math.min(read, MAX_READ_BYTES)).toString("utf8");
    if (read > MAX_READ_BYTES) text += "\n[truncated]";
    return outcome(spec.name, "tool_ok", true, text, data);
  } catch (error) {
    return outcome(spec.name, "failed", false, `could not read it: ${String((error as Error)?.message ?? error)}`, data);
  }
}

async function runInstall(spec: ToolSpec, args: Record<string, unknown>): Promise<ToolOutcome> {
  const name = String(args.name ?? "").trim();
  let result: { verdict: string; exit_code: number; output: string; infra_failure: string[] | null; already_installed?: boolean };
  try {
    result = await installPackage(name, "npm");
  } catch (error) {
    return outcome(spec.name, "failed", false, String((error as Error)?.message ?? error), { package: name });
  }
  const verdict = result.verdict || "none";
  const data: Record<string, unknown> = { package: name, verdict, exit_code: result.exit_code, governed: verdict !== "none" };
  const firstLine = (result.output ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  if (result.infra_failure?.length) {
    return outcome(spec.name, "failed", false, `Package Guard could not evaluate ${name} (${result.infra_failure.join(", ")}); this is a fault, not a refusal`, data);
  }
  if (result.already_installed) return outcome(spec.name, "pkg_allow", true, `${name} is already installed; nothing was added`, data);
  if (verdict === "block") return outcome(spec.name, "pkg_block", false, firstLine || `Package Guard refused ${name}`, data);
  if (verdict === "hold") return outcome(spec.name, "pkg_hold", false, firstLine || `Package Guard is holding ${name} for an operator's decision`, data);
  if (verdict === "allow" || result.exit_code === 0) {
    return outcome(spec.name, "pkg_allow", true, verdict === "allow" ? `${name} installed; Package Guard allowed it` : `${name} installed; nothing checked it first`, data);
  }
  return outcome(spec.name, "failed", false, (result.output ?? "").slice(-600) || `npm exited ${result.exit_code}`, data);
}

/** What the model reads. Says what happened, and what NOT to do next. */
export function modelText(o: ToolOutcome): string {
  const d = o.data;
  switch (o.signal) {
    case "tool_ok":
      return o.detail || "Done.";
    case "tool_held":
      return `AgentBox has PAUSED this action and it has NOT run. A manager must approve it in the admin console first${o.approval_id ? ` (approval id: ${o.approval_id})` : ""}; after that the same request has to be made again. Tell the user it is waiting for approval, and stop.`;
    case "tool_denied":
      return `AgentBox refused this action, so it did not run: ${o.detail} Tell the user it was not allowed.`;
    case "egress_blocked":
      return `AgentBox did not allow a connection to ${d.host}: it is not on this application's list of allowed sites, so nothing was sent or read. Tell the user the site is not on the list.`;
    case "egress_ok": {
      const note = d.proxied ? "" : " This application has no outbound gate, so the request went straight out.";
      return d.verb === "read" ? `${o.detail}${note}` : `Sent to ${d.host}; it answered HTTP ${d.status}.${note}`;
    }
    case "pkg_block":
      return `Package Guard refused to install ${d.package} and nothing was downloaded: ${o.detail} Tell the user the package was refused.`;
    case "pkg_hold":
      return `Package Guard is holding the install of ${d.package} until an operator decides; it has not been installed. Tell the user it is waiting.`;
    case "pkg_allow":
      return `${o.detail}.`;
    case "note_quarantined":
      return "AgentBox removed the note seconds after you wrote it: its content tripped a rule, so it is in quarantine and you cannot read it back. Tell the user the note was quarantined; do not write it again.";
    case "note_kept":
      return `The note is kept.${d.watched ? " AgentBox watches your notes and left this one alone." : " Nothing watches your notes here."}`;
    default:
      return `This could not be completed: ${o.detail} This is a failure, not a policy decision; say so plainly and do not guess at a result.`;
  }
}
