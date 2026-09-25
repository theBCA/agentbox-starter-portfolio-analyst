// Where this application's TLS trust comes from, and a refusal when it is off.
//
// SecureProxy terminates TLS on the forward proxy using a per-install CA, and
// AgentBox injects that CA into every application image (plan 0.11.3).
// Injecting into the SYSTEM trust store is not sufficient here, because Node
// uses its own compiled-in roots and ignores the system store entirely. The
// image-rewrite step therefore sets NODE_EXTRA_CA_CERTS, which Node reads ONCE
// AT STARTUP and merges into its default trust store.
//
// "Once at startup" is the whole reason this file reports rather than
// configures. Nothing an app does at request time can add a CA to Node's
// default store, so the only useful thing an app can do is (a) not defeat the
// one it was given and (b) say plainly whether it arrived.
//
// Two states that look alike and are not, reported separately:
//
//   * disabled      -- NODE_TLS_REJECT_UNAUTHORIZED=0. Requests succeed and
//                      prove nothing.
//   * misconfigured -- NODE_EXTRA_CA_CERTS names a file that is not there.
//                      This is the SILENT one in Node: a warning on stderr
//                      that nobody reads, and the process continues with the
//                      CA missing, so every intercepted request fails later
//                      with a certificate error that names the wrong cause.
//                      (In the Python starters the same shape is loud --
//                      `ssl` and `requests` both raise. Same variable class,
//                      opposite failure mode, so neither family folds the two
//                      together.)

import { existsSync } from "node:fs";

export const TRUST_ENV_VARS: string[] = ["NODE_EXTRA_CA_CERTS"];

export interface TrustSource {
  variable: string;
  value: string;
  exists: boolean;
}

// Debian/Alpine's system bundle. Only the system tools (curl, apk) read it;
// it is reported so an operator can see that half landed even when Node's own
// variable did not.
export const SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

export class TlsVerificationDisabled extends Error {}

function pathExists(value: string): boolean {
  try {
    return existsSync(value);
  } catch {
    return false;
  }
}

export function trustSources(): TrustSource[] {
  return TRUST_ENV_VARS.map((variable) => {
    const value = (process.env[variable] ?? "").trim();
    return value ? { variable, value, exists: pathExists(value) } : null;
  }).filter((source): source is TrustSource => source !== null);
}

// Not a boolean: "why" is what an operator needs, and a boolean would make two
// different misconfigurations indistinguishable.
export function verificationDisabledBy(): string[] {
  const reasons: string[] = [];
  if ((process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? "").trim() === "0") {
    reasons.push("NODE_TLS_REJECT_UNAUTHORIZED=0");
  }
  return reasons;
}

export function misconfiguredSources(): string[] {
  return trustSources()
    .filter((source) => !source.exists)
    .map((source) => `${source.variable}=${source.value} (no such file)`);
}

export function assertVerificationEnabled(): void {
  const reasons = verificationDisabledBy();
  if (reasons.length) {
    throw new TlsVerificationDisabled(
      `refusing to make an outbound request with TLS verification disabled: ${reasons.join(", ")}`,
    );
  }
}

export function describeTrust() {
  const disabled = verificationDisabledBy();
  return {
    verification_enabled: disabled.length === 0,
    disabled_by: disabled,
    misconfigured: misconfiguredSources(),
    sources: trustSources(),
    system_ca_bundle: {
      path: SYSTEM_CA_BUNDLE,
      exists: pathExists(SYSTEM_CA_BUNDLE),
    },
    note:
      "AgentBox injects its per-install CA into this image and sets " +
      "NODE_EXTRA_CA_CERTS. No source here means this app would reject " +
      "SecureProxy's intercepted TLS -- Node ignores the system store.",
  };
}
