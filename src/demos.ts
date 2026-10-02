/**
 * Demonstration endpoints' plumbing: Package Guard and SecureProxy egress.
 *
 * Neither is something an agent framework gives you. They exist so a customer
 * evaluating AgentBox can trigger the two controls that previously had no path
 * at all from inside a running application -- package policy and egress policy
 * -- and see the platform's own verdict, in the platform's own words.
 *
 * Both are deliberately thin: they run the real thing and report what came
 * back. Neither interprets policy, and neither has a "pretend" mode.
 */

import { execFile, execFileSync } from "node:child_process";
import type { ExecFileException } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export interface InstallResult {
  package: string;
  manager: string;
  verdict: string;
  exit_code: number;
  output: string;
  infra_failure: string[] | null;
  already_installed?: boolean;
}

export interface EgressResult {
  host: string;
  port: number;
  proxied: boolean;
  status: number;
  reason: string;
  allowed?: boolean;
}

/** Carries the HTTP status the route should answer with. */
export class DemoError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "DemoError";
    this.status = status;
  }
}

// --------------------------------------------------------------- Package Guard

// An ALLOWLIST, and `pip` is the spelling to use: on most Python images the
// various pip aliases are one binary, and this endpoint accepts the name
// Package Guard installs its shim for rather than every alias of it. Wrapping
// more than one of them in a single pass was measured to leave a dangling
// symlink that crashed every install (2026-08-20), which is why there is one
// governed name and not several.
const MANAGERS = new Set(["npm", "pip"]);

// A package name, an optional npm scope, and an optional version specifier.
// The install runs WITHOUT a shell, so this is defence in depth rather than the
// only thing between a name and a command -- but a name that cannot be a
// package should be refused before Package Guard is asked about it.
//
// Both optional halves are real, not hypothetical: a first version of this
// accepted neither, which refused `@scope/name` and `docopt==0.6.2` -- an
// ordinary scoped npm package and an ordinary pinned pip install. A scope must
// begin with an alphanumeric so `@../evil/x` cannot pass as one.
const PACKAGE_RE =
  /^(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:[@=<>!~^][A-Za-z0-9._*+!=<>~^-]{0,63})?$/;

// npm needs a project root it can write. /app is an image layer under a
// read-only rootfs, and npm walks UP to the nearest package.json, so without
// one here it targets /app and fails with a misleading ENOENT about a
// platform-specific package. /home/agent/scratch is declared in filesystem_writable.
const INSTALL_ROOT = process.env.DOCBRIEF_INSTALL_ROOT ?? "/home/agent/scratch";

// Substrings meaning Package Guard FAILED rather than DECIDED. They matter because
// they are invisible in the verdict: the daemon wraps every exception as
// "Blocked by Package Guard: {exc}", so an infrastructure failure reads word
// for word like a policy block. Each was a real failure seen live 2026-08-29.
const INFRA_FAILURES = [
  "execv",
  "staticx",
  "daemon unavailable",
  "daemon returned no final response",
  "resolution failed",
  "error loading shared library",
  "unsupported resolver tool",
  "connection refused",
];

/**
 * Which decision Package Guard rendered.
 *
 * Keys off the exact prefixes policy.py emits rather than loose keywords:
 * "approval" appears both in a genuine HOLD and in "Blocked by ...: approval
 * request was rejected", so keyword matching cannot tell the two apart.
 */
function verdictOf(output: string): string {
  const lowered = output.toLowerCase();
  if (lowered.includes("blocked by package guard")) return "block";
  if (lowered.includes("held by package guard")) return "hold";
  if (lowered.includes("allowed by package guard")) return "allow";
  return "none";
}

function ensureInstallRoot(): void {
  fs.mkdirSync(INSTALL_ROOT, { recursive: true });
  const manifest = path.join(INSTALL_ROOT, "package.json");
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(manifest, '{"name":"agent-scratch","private":true}');
  }
}

/**
 * Run a real, Package Guard-governed install and report the verdict.
 *
 * Invoked as a bare argv, NOT through a shell: a login shell (`sh -lc`)
 * re-initialises PATH from the image profile and drops the shim directory
 * entirely -- confirmed live 2026-08-29, where a login shell saw no npm at
 * all. This process inherits the container's ENV PATH, which has the shim
 * directory on it, so a bare name resolves to the wrapper exactly as an
 * agent's own call would.
 */
// Whether the package is already there, so there is nothing to install.
// Asked BEFORE installing, because Package Guard judges every install request
// on its own: after an operator approved a held install and it completed, the
// agent's next "install it" raised a NEW hold and the agent said the package
// was not installed yet (measured on the VM 2026-09-24). Skipping an install
// that would change nothing bypasses no control. npm is checked on disk, never
// with `npm ls`; `pip show` answers for any distribution shape.
function alreadyInstalled(name: string, tool: string): boolean {
  if (tool === "npm") return fs.existsSync(path.join(INSTALL_ROOT, "node_modules", name));
  try {
    execFileSync(tool, ["show", name], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

export function installPackage(pkg: unknown, manager: unknown): Promise<InstallResult> {
  const name = String(pkg ?? "").trim();
  const tool = String(manager ?? "").trim().toLowerCase();
  if (!MANAGERS.has(tool)) {
    throw new DemoError(`manager must be one of ${[...MANAGERS].join(", ")}`, 400);
  }
  if (!PACKAGE_RE.test(name)) {
    throw new DemoError("package is not a valid package name", 400);
  }

  if (alreadyInstalled(name, tool)) {
    return Promise.resolve({
      package: name,
      manager: tool,
      verdict: "installed",
      exit_code: 0,
      output: `${name} is already installed; there is nothing to add.`,
      infra_failure: null,
      already_installed: true,
    });
  }

  let cwd: string | undefined;
  if (tool === "npm") {
    ensureInstallRoot();
    cwd = INSTALL_ROOT;
  }

  return new Promise<InstallResult>((resolve, reject) => {
    execFile(
      tool,
      ["install", name],
      {
        cwd,
        // 300s, not 180: an ALLOWed package proceeds to a real download, and
        // 180 was hit for real on 2026-08-29. A timeout reported as a failure
        // would misattribute a slow network to Package Guard.
        timeout: 300_000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error && error.code === "ENOENT") {
          reject(
            new DemoError(
              `${tool} is not installed in this image, so Package Guard's shim has nothing to wrap`,
              502,
            ),
          );
          return;
        }
        if (error?.killed) {
          reject(new DemoError(`${tool} install of ${name} did not finish within 300s`, 502));
          return;
        }
        const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
        const lowered = output.toLowerCase();
        const infra = INFRA_FAILURES.filter((needle) => lowered.includes(needle));
        resolve({
          package: name,
          manager: tool,
          verdict: verdictOf(output),
          exit_code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          // Bounded: an ALLOWed install prints a full resolution log, and this
          // is rendered in an admin's browser.
          output: output.slice(-4000),
          // A verdict reached by a broken Package Guard fails CLOSED, which is the
          // safe direction but also the deceptive one -- it looks exactly like
          // a policy block. Name it rather than let it read as enforcement.
          infra_failure: infra.length ? infra : null,
        });
      },
    );
  });
}

// ------------------------------------------------------- SecureProxy egress

const HOST_RE = /^[A-Za-z0-9._-]{1,253}$/;

/**
 * Ask SecureProxy's forward proxy to open a tunnel, and report its answer.
 *
 * A RAW CONNECT, reading the proxy's own status line, rather than an ordinary
 * HTTPS request: a denied CONNECT surfaces to an HTTP client as a generic
 * socket error with the proxy's status discarded, so a probe built on `fetch`
 * reports the same opaque failure whether the destination was refused by
 * policy or the proxy itself was broken. Reading the status line keeps "403
 * Forbidden" distinct from "cannot reach the proxy at all", which is the
 * entire question here.
 */
export function probeEgress(host: unknown, port: unknown = 443): Promise<EgressResult> {
  const target = String(host ?? "").trim();
  if (!HOST_RE.test(target)) {
    throw new DemoError("host must be a bare hostname, without scheme or path", 400);
  }
  const targetPort = Number(port);
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    throw new DemoError("port must be between 1 and 65535", 400);
  }

  const base = { host: target, port: targetPort };
  const raw = (process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "").trim();
  if (!raw) {
    return Promise.resolve({
      ...base,
      proxied: false,
      status: 0,
      reason: "no HTTPS_PROXY is set, so this app has no egress route at all",
    });
  }

  let proxy: URL;
  try {
    proxy = new URL(raw);
  } catch {
    return Promise.resolve({ ...base, proxied: false, status: 0, reason: `unparseable proxy url: ${raw}` });
  }
  const proxyPort = Number(proxy.port);
  if (!proxy.hostname || !proxyPort) {
    return Promise.resolve({ ...base, proxied: false, status: 0, reason: `unparseable proxy url: ${raw}` });
  }

  const lines = [`CONNECT ${target}:${targetPort} HTTP/1.1`, `Host: ${target}:${targetPort}`];
  if (proxy.username) {
    // Spelled exactly `Proxy-Authorization`. Only the exact casing is
    // forwarded into the tunnel by the proxy, and a client library that
    // normalises the header name produces a 407 on every request -- which
    // silently disabled Package Guard's own intel fetches until it was found.
    const token = Buffer.from(
      `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password ?? "")}`,
    ).toString("base64");
    lines.push(`Proxy-Authorization: Basic ${token}`);
  }

  return new Promise<EgressResult>((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: proxy.hostname, port: proxyPort });
    const finish = (payload: Omit<EgressResult, "host" | "port">): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...base, ...payload });
    };

    socket.setTimeout(25_000);
    socket.on("connect", () => {
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    socket.on("timeout", () =>
      finish({ proxied: true, status: 0, reason: "the proxy did not answer within 25s" }),
    );
    socket.on("error", (error: Error) =>
      finish({
        proxied: false,
        status: 0,
        reason: `cannot reach the proxy at ${proxy.hostname}:${proxyPort} -- ${error.message}`,
      }),
    );
    socket.on("close", () =>
      finish({ proxied: true, status: 0, reason: "the proxy closed the connection without a status line" }),
    );

    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      if (!buffer.includes("\r\n")) return;
      const statusLine = buffer.split("\r\n", 1)[0] ?? "";
      const bits = statusLine.split(/\s+/);
      if (bits.length < 2 || !/^\d+$/.test(bits[1] ?? "")) {
        finish({ proxied: true, status: 0, reason: `unparseable proxy status line: ${statusLine}` });
        return;
      }
      const status = Number(bits[1]);
      finish({
        proxied: true,
        status,
        reason: bits.slice(2).join(" "),
        // 200 means the tunnel opened: this destination is allowed by the
        // app's current egress policy. 403 is the policy refusing it. 407
        // means the credential did not survive, a wiring fault rather than a
        // policy decision.
        allowed: status === 200,
      });
    });
  });
}
