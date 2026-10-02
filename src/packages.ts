// Installing a package at runtime, through package-guard.
//
// §0.27.4 item 10 asks a starter to install a package at runtime *through*
// package-guard, "so the governed path is demonstrated rather than
// described". The description is the easy half and it was already there;
// this is the half that runs.
//
// Four things about the governed path in a Node application, all of them
// measured rather than assumed:
//
// 1. A hardened app CANNOT install into /app/node_modules. That path is an
//    image layer under a read-only rootfs. And npm walks UP to the nearest
//    package.json, so changing directory does not help: npm still targets
//    /app and fails with `ENOENT: mkdir /app/node_modules/...`, which reads
//    like a platform-variant bug and is really "read-only".
//
// 2. `npm install --prefix <dir>` is refused by package-guard as an
//    unsupported install shape. That is fail-closed and correct -- it is not
//    the way round this.
//
// 3. The shape that works is a WRITABLE DIRECTORY WITH ITS OWN package.json.
//    /home/agent/scratch is declared in this app's `filesystem_writable`, so seeding
//    a package.json there makes `npm install <pkg>` land in
//    /home/agent/scratch/node_modules. Seeding it is this module's job, because an
//    empty writable directory is not enough.
//
// 4. The governed entry point is the `npm` BINARY on PATH, which
//    package-guard shims. The image deliberately KEEPS npm rather than
//    deleting it: removing the binary was once thought to be hardening, but
//    package-guard already resolves the tree, scans the artifact, checks
//    advisories and records the decision -- and deleting npm only meant the
//    shim died in the resolver on a missing `npm.real`, so no starter could
//    exercise npm policy at all and a DENY probe went green without ever
//    reaching a verdict.
//
// A refusal is an ANSWER: package-guard writes `Blocked by Package Guard:
// <reason>` to stderr and exits non-zero. That is a policy decision about the
// package, not a failure of this endpoint, and the two are reported apart.

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Declared in this app's `filesystem_writable`, and mounted as a writable
// volume. Nothing else in the container is writable.
export const INSTALL_ROOT = "/home/agent/scratch";

export const ECOSYSTEM = "npm";

export interface InstallResult {
  ecosystem: string;
  requirement: string;
  command: string[];
  install_root: string;
  exit_code: number;
  verdict: string;
  reason: string;
  stdout_tail: string;
  stderr_tail: string;
}

export const BLOCKED_MARKER = "Blocked by Package Guard";

export const DEFAULT_TIMEOUT_MS = 300_000;

// Conservative, and checked BEFORE anything is spawned. The command is built
// as an argv array and never goes through a shell, so this is defence in
// depth -- but a name is caller-supplied input, and an option smuggled into
// it (`--registry=...`) would be an argument to npm, not a package.
const SPECIFIER_RE =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[A-Za-z0-9._^~><=*+-]+)?$/;

export class InvalidSpecifier extends Error {}

// An empty writable directory is not enough: npm would walk up out of it and
// target /app again. The package.json is what stops the walk.
export async function ensureInstallRoot(root: string = INSTALL_ROOT): Promise<string> {
  await mkdir(root, { recursive: true });
  const manifest = path.join(root, "package.json");
  try {
    await readFile(manifest, "utf8");
  } catch {
    await writeFile(
      manifest,
      `${JSON.stringify(
        { name: "agentbox-scratch", private: true, version: "1.0.0" },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  return manifest;
}

function run(
  command: string,
  args: string[],
  { cwd, timeoutMs }: { cwd: string; timeoutMs: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // argv array, never a shell string.
    const child = spawn(command, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export async function install(
  specifier: string,
  { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<InstallResult> {
  if (!SPECIFIER_RE.test(specifier)) {
    throw new InvalidSpecifier(
      `${JSON.stringify(specifier)} is not a bare package name with an optional ` +
        "version; this endpoint will not pass options through to npm",
    );
  }
  const root = INSTALL_ROOT;
  await ensureInstallRoot(root);

  // `npm`, resolved through PATH so the shim gets it. No `--prefix`: the
  // parser refuses that shape, fail-closed.
  const args = ["install", specifier];
  const result = await run("npm", args, { cwd: root, timeoutMs });
  const blocked = result.stderr.includes(BLOCKED_MARKER);
  return {
    ecosystem: ECOSYSTEM,
    requirement: specifier,
    command: ["npm", ...args],
    install_root: root,
    exit_code: result.code,
    // Three outcomes, not two: "policy refused this package" and "the install
    // itself failed" send an operator to different places.
    verdict: blocked ? "blocked" : result.code === 0 ? "installed" : "failed",
    reason: blocked ? blockedReason(result.stderr) : "",
    stdout_tail: result.stdout.slice(-2000),
    stderr_tail: result.stderr.slice(-2000),
  };
}

function blockedReason(stderr: string): string {
  for (const line of stderr.split("\n")) {
    if (line.includes(BLOCKED_MARKER)) return line.trim();
  }
  return BLOCKED_MARKER;
}
