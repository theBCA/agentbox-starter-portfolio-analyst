// What this application can observe about its own confinement.
//
// The TypeScript twin of the Python starter's `app/posture.py`, and it follows
// the same three rules, each earned elsewhere in the product:
//
//   1. Report the EVIDENCE, never the value. Every proxy variable an app
//      receives carries this app's own virtual key as its credential, so this
//      reports THAT a variable is set and never what it holds.
//   2. A control this app cannot see is `null`, not `false`. gVisor, the audit
//      trail and the Hardening Check act on the app from outside it and leave
//      nothing in here to read; calling them "absent" would be a fabricated
//      finding.
//   3. The managed test is the SAME one the model path uses, so the banner and
//      the fail-closed refusal cannot disagree.
//
// One genuine difference from the Python file, and it is not cosmetic: this
// runtime reads its CA material from `NODE_EXTRA_CA_CERTS`, not from
// `SSL_CERT_FILE`/`REQUESTS_CA_BUNDLE`. `tlsTrust.js` already encodes that, so
// this module asks it rather than repeating the list.

import fs from "fs";
import path from "path";
import { proxyConfiguration } from "./egress.js";
import { misconfiguredSources, trustSources, verificationDisabledBy } from "./tlsTrust.js";

const PACKAGE_GUARD_DIR = "/app/package-guard";
const PACKAGE_GUARD_SHIM_DIR = path.join(PACKAGE_GUARD_DIR, "shims");
const PACKAGE_GUARD_RUNTIME = path.join(PACKAGE_GUARD_DIR, "package-guard-runtime");

// The env var each agent SDK reads its credential from, keyed on the SDK
// rather than the provider: an SDK reads a fixed name and will not read
// another.
const SDK_KEY_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"];

const env = (name: string): string => (process.env[name] ?? "").trim();
const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const exists = (p: string): boolean => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Whether AgentBox provisioned this container. Identical to the test in
 *  `backends/secureproxy.js`, so the two cannot disagree. */
export function managed(): boolean {
  return Boolean(env("AGENTBOX_APP_ID")) || env("KOBIL_SECUREPROXY_REQUIRED") === "1";
}

/** Credential variables holding something OTHER than this app's virtual key.
 *  A managed app's SDK variable IS set -- the proxy binding writes it -- so
 *  "is it set" answers the wrong question. Returns NAMES, never values. */
export function rawProviderKeyVars(): string[] {
  const virtual = env("KOBIL_SECUREPROXY_API_KEY");
  return SDK_KEY_VARS.filter((name) => {
    const value = env(name);
    return value && (!virtual || value !== virtual);
  });
}

function packageGuardState(): [boolean | null, string] {
  const onPath = (process.env.PATH ?? "").split(":").includes(PACKAGE_GUARD_SHIM_DIR);
  const runtimePresent = exists(PACKAGE_GUARD_RUNTIME);
  if (onPath && runtimePresent)
    return [true, `the shim directory ${PACKAGE_GUARD_SHIM_DIR} is on PATH and the runtime is present`];
  if (onPath && !runtimePresent)
    return [
      false,
      `the shim directory is on PATH but ${PACKAGE_GUARD_RUNTIME} is missing -- installs will fail ` +
        "closed, which looks like a policy block and is not one",
    ];
  if (runtimePresent)
    return [false, "the runtime is present but its shim directory is not on PATH, so installs bypass it"];
  return [false, "no Package Guard shim directory on PATH"];
}

export interface ControlRow {
  id: string;
  name: string;
  wired: boolean | null;
  detail: string;
  absent_detail: string;
  evidence: string;
}

export function controls(): ControlRow[] {
  const proxyVars = proxyConfiguration();
  const proxied = Object.values(proxyVars).some(Boolean);
  const sources = trustSources();
  const disabledBy = verificationDisabledBy();
  const misconfigured = misconfiguredSources();

  const agenticFiles = env("AGENTBOX_AGENTIC_FILES_PATH");
  const skillsRoot = env("AGENTBOX_SKILLS_ROOT");
  const bridgeUrl = env("MANAGED_MCP_BRIDGE_URL");
  const bridgeToken = env("AGENTBOX_CUSTOM_APP_MCP_TOKEN");
  const [guardWired, guardEvidence] = packageGuardState();
  const rawKeys = rawProviderKeyVars();

  const proxyConfigured = Boolean(env("KOBIL_SECUREPROXY_URL") && env("KOBIL_SECUREPROXY_API_KEY"));
  let secureproxyEvidence = proxyConfigured
    ? "KOBIL_SECUREPROXY_URL and KOBIL_SECUREPROXY_API_KEY are both set"
    : "no SecureProxy URL and virtual key in this environment";
  secureproxyEvidence += rawKeys.length
    ? `; this app can read a real provider key (${rawKeys.join(", ")})`
    : "; this app holds no raw provider key";

  const tlsClauses = [
    sources.length
      ? sources.map((s: { variable: string; exists: boolean }) => `${s.variable} -> ${s.exists ? "present" : "MISSING"}`).join(", ")
      : "no CA variables set",
  ];
  if (disabledBy.length) tlsClauses.push(`verification disabled by ${disabledBy.join(", ")}`);
  if (misconfigured.length) tlsClauses.push(`misconfigured: ${misconfigured.join(", ")}`);

  const rows: ControlRow[] = [
    {
      id: "secureproxy",
      name: "SecureProxy LLM gateway",
      wired: proxyConfigured,
      detail:
        "Model calls are brokered. This app holds no provider key -- it was handed a per-app virtual " +
        "key and a proxy base URL, and the SDK was pointed at them.",
      absent_detail:
        "The SDK talks to the vendor directly, with a real provider key this app can read. Nothing " +
        "inspects the prompt or the answer.",
      evidence: secureproxyEvidence,
    },
    {
      id: "egress",
      name: "Egress policy (forward proxy)",
      wired: proxied,
      detail:
        "The only route out of this app's private network is SecureProxy's forward proxy, which " +
        `decides each destination against this application's own policy (mode: ${env("AGENTBOX_EGRESS_MODE") || "unknown"}).`,
      absent_detail:
        "No proxy is configured, so outbound requests go straight out. Nothing decides which " +
        "destinations this app may reach.",
      evidence: proxied
        ? `${Object.entries(proxyVars).filter(([, v]) => v).map(([k]) => k).join(", ")} set ` +
          "(values withheld -- each carries this app's virtual key)"
        : "no proxy variables set in this environment",
    },
    {
      id: "tls",
      name: "TLS trust",
      // Tri-state, and `null` is the ordinary case: SecureProxy tunnels TLS
      // rather than intercepting it, so there is no substituted certificate to
      // trust. `false` is reserved for an app that defeated its own
      // verification, or names a CA file that is not there.
      wired: disabledBy.length || misconfigured.length ? false : sources.length ? true : null,
      detail:
        "A platform CA is configured and the files it names are present, so an inspected channel " +
        "would verify. The correct amount of TLS configuration in an AgentBox app is none.",
      absent_detail:
        "This app has weakened its own TLS verification, or names a CA file that is not there. " +
        "Either way an outbound request is not verifying what it claims to.",
      evidence:
        sources.length || disabledBy.length || misconfigured.length
          ? tlsClauses.join("; ")
          : "no CA variables set, and none is needed: SecureProxy tunnels TLS rather than " +
            "intercepting it, so there is no substituted certificate to trust.",
    },
    {
      id: "mcp_bridge",
      name: "MCP Bridge",
      wired: Boolean(bridgeUrl && bridgeToken),
      detail:
        "This app has no direct route to any MCP server. Every tool call goes through the bridge, " +
        "which checks that THIS application has a grant for THAT server, and holds destructive " +
        "tools for approval.",
      absent_detail:
        "No bridge. An app in this state either reaches its MCP servers directly or not at all -- " +
        "either way nothing checks the grant.",
      evidence:
        bridgeUrl && bridgeToken
          ? "MANAGED_MCP_BRIDGE_URL and an app token are both set"
          : `bridge URL ${bridgeUrl ? "set" : "absent"}, app token ${bridgeToken ? "set" : "absent"}`,
    },
    {
      id: "package_guard",
      name: "Package Guard",
      wired: guardWired,
      detail:
        "An install reaches a policy decision point before anything is downloaded: allow, block, or " +
        "hold for an operator.",
      absent_detail:
        "An install reaches the package manager. Whatever the agent asks for, it gets -- including a " +
        "typosquat.",
      evidence: guardEvidence,
    },
    {
      id: "file_guard",
      name: "agentic-file-guard",
      wired: Boolean(agenticFiles) && isDir(agenticFiles),
      detail:
        `The agent's own files live at ${agenticFiles || "(unset)"}, on a volume the guard watches ` +
        "from outside this container. It scans CONTENT, so a clean write produces nothing and a " +
        "poisoned one is quarantined.",
      absent_detail:
        "The agent's files are ordinary container files. Nothing scans what the agent writes to itself.",
      evidence:
        agenticFiles && isDir(agenticFiles)
          ? `AGENTBOX_AGENTIC_FILES_PATH=${agenticFiles} exists`
          : `AGENTBOX_AGENTIC_FILES_PATH=${agenticFiles || "(unset)"}`,
    },
    {
      id: "skills",
      name: "Scanned skills",
      wired: Boolean(skillsRoot) && isDir(skillsRoot),
      detail:
        "Skills are mounted read-only, one per approved skill, after the Skill Scanner cleared them. " +
        "This app folds them into its system instructions and cannot write to them.",
      absent_detail:
        "No scanned-skill mount. Any instructions the agent picks up came from somewhere nothing checked.",
      evidence: skillsRoot
        ? `AGENTBOX_SKILLS_ROOT=${skillsRoot}; declared: ${env("AGENTBOX_ALLOWED_SKILLS") || "none"}`
        : "AGENTBOX_SKILLS_ROOT is unset",
    },
  ];

  // Rule 2: these act on the application from outside it.
  const unobservable: Array<[string, string, string]> = [
    [
      "sandbox",
      "gVisor sandbox",
      "Whether this container's syscalls are intercepted is a property of the runtime Docker started " +
        "it with. `agentbox status` and the app's own card in the admin console answer it.",
    ],
    [
      "audit",
      "Audit trail",
      "Events are written by the platform's own components, not by this app, and an app that could " +
        "read the trail could also shape it. Security -> Audit Log is the surface.",
    ],
    [
      "hardening_check",
      "Hardening Check",
      "A pre-flight scan of this container's own posture, run on the host before the app is allowed " +
        "to serve. Its findings are on the app's card.",
    ],
  ];
  for (const [id, name, detail] of unobservable) {
    rows.push({
      id,
      name,
      wired: null,
      detail,
      absent_detail: detail,
      evidence: "not observable from inside the container -- ask the platform",
    });
  }
  return rows;
}

/** The whole answer, in the shape `GET /runtime-info` returns. */
export function describe(): Record<string, unknown> {
  const rows = controls();
  return {
    managed: managed(),
    app_id: env("AGENTBOX_APP_ID"),
    agent_type: env("AGENTBOX_APP_TYPE") || "",
    provider: env("AGENTBOX_MODEL_PROVIDER"),
    egress_mode: env("AGENTBOX_EGRESS_MODE"),
    skills: env("AGENTBOX_ALLOWED_SKILLS").split(",").map((s: string) => s.trim()).filter(Boolean),
    // Names of credential variables holding something OTHER than this app's
    // own virtual key. Empty is the claim the product makes; the page renders
    // "where is the AI key" from this field, never from the model's answer.
    raw_provider_keys: rawProviderKeyVars(),
    controls: rows,
    wired_count: rows.filter((r: ControlRow) => r.wired === true).length,
    observable_count: rows.filter((r: ControlRow) => r.wired !== null).length,
  };
}

/** What the agent may truthfully say about its own setup, as prose for the
 * system prompt -- the same facts the banner derives from, so the answer to
 * "which AI key are you using" is grounded in them rather than in what a
 * model assumes about apps in general. Names of variables, never values. */
export function selfFacts(): string {
  const raw = rawProviderKeyVars();
  const proxied = Boolean(env("KOBIL_SECUREPROXY_URL") && env("KOBIL_SECUREPROXY_API_KEY"));
  const bridged = Boolean(env("MANAGED_MCP_BRIDGE_URL") && env("AGENTBOX_CUSTOM_APP_MCP_TOKEN"));
  const [guardWired] = packageGuardState();
  const lines = ["Facts about your own setup, for when you are asked. Say only these; do not guess beyond them."];
  if (raw.length) {
    lines.push(
      `You hold a real AI key in your environment (${raw.join(", ")}). Nothing stands between you and the AI company. If that key leaked, whoever has it could spend the company's money and read its traffic until someone noticed and replaced it.`,
    );
  } else if (proxied) {
    lines.push(
      "Your calls to the AI go through AgentBox. You were given a pass that belongs to this application alone; you do not hold, and cannot read, the company's real AI key. If your pass leaked it could be switched off on its own, and it is worth nothing at the AI company.",
    );
  } else {
    lines.push("You hold no AI key in your environment and no AgentBox pass either.");
  }
  lines.push(
    bridged
      ? "The company's systems are reached through AgentBox, which checks each call and keeps a record of it."
      : "You have no connection to the company's systems through AgentBox.",
  );
  if (guardWired === true) lines.push("Software you add is checked by AgentBox before it is installed.");
  else if (guardWired === false) lines.push("Nothing checks software you add before it is installed.");
  return lines.join("\n");
}

