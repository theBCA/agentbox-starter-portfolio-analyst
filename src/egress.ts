// Outbound HTTPS from inside an AgentBox application.
//
// Every byte an application sends to the internet goes through SecureProxy's
// forward proxy, and SecureProxy terminates TLS there using a per-install CA
// (plan 0.11.3). Two things follow that a bare `fetch()` gets wrong, and both
// are why this module exists rather than a one-liner.
//
// 1. Node's global fetch DOES NOT READ HTTP_PROXY/HTTPS_PROXY. undici ignores
//    proxy environment variables entirely; honouring them needs a ProxyAgent,
//    which is not reachable without adding the `undici` package. An app
//    container has NO route to the internet other than the proxy, so a bare
//    fetch does not "bypass" the proxy -- it simply cannot connect, and the
//    error it reports names DNS or a refused socket rather than the missing
//    proxy. So the CONNECT tunnel is established explicitly below, with
//    built-ins only.
//
// 2. The credential header must be spelled `Proxy-Authorization`. That is
//    trivially true here because the header is written by hand -- but it is
//    the exact bug that silently 407'd Python's urllib, whose ProxyHandler
//    capitalises it to `Proxy-authorization` and then never forwards it into
//    the tunnel. Worth stating in both families.
//
// What is deliberately NOT done: no `ca` option and no `rejectUnauthorized`.
// Node has already merged NODE_EXTRA_CA_CERTS into its default trust store at
// startup, so passing `ca` would REPLACE the platform's roots with the app's
// idea of them. The correct amount of TLS configuration in an AgentBox
// application is none.

import http from "node:http";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import tls from "node:tls";
import { assertVerificationEnabled, describeTrust } from "./tlsTrust.js";

export const PROXY_ENV_VARS: string[] = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
];

export interface EgressResult {
  url: string;
  status: number;
  body_prefix: string;
  proxy: Record<string, boolean>;
  trust: Record<string, unknown>;
}

export const DEFAULT_TIMEOUT_MS = 20_000;

// Values are NOT returned: the forward proxy URL carries this app's virtual
// key as its credential.
export function proxyConfiguration(): Record<string, boolean> {
  return Object.fromEntries(
    PROXY_ENV_VARS.map((name) => [name, Boolean((process.env[name] ?? "").trim())]),
  );
}

function resolveProxy(): URL | null {
  for (const name of PROXY_ENV_VARS) {
    const value = (process.env[name] ?? "").trim();
    if (value) return new URL(value);
  }
  return null;
}

function openTunnel(
  proxy: URL,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `${host}:${port}` };
    if (proxy.username) {
      const credential = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(credential).toString("base64")}`;
    }
    const request = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 8101),
      method: "CONNECT",
      path: `${host}:${port}`,
      headers,
      timeout: timeoutMs,
    });
    request.on("connect", (response: IncomingMessage, socket: Socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        // A proxy refusal is a POLICY answer and must stay distinguishable
        // from a transport failure: 407 is a credential problem, 403 is this
        // app's egress list saying no.
        reject(new Error(`proxy refused CONNECT with HTTP ${response.statusCode}`));
        return;
      }
      resolve(socket);
    });
    request.on("timeout", () => request.destroy(new Error("proxy CONNECT timed out")));
    request.on("error", reject);
    request.end();
  });
}

function readOverTls(
  socket: Socket,
  target: URL,
  timeoutMs: number,
): Promise<{ status: number; body_prefix: string }> {
  return new Promise((resolve, reject) => {
    // No `ca`, no `rejectUnauthorized`: the defaults are what AgentBox set up.
    const secure = tls.connect({ socket, servername: target.hostname }, () => {
      secure.write(
        `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
          `Host: ${target.hostname}\r\n` +
          "User-Agent: agentbox-starter\r\n" +
          "Connection: close\r\n\r\n",
      );
    });
    const chunks: Buffer[] = [];
    secure.setTimeout(timeoutMs, () => secure.destroy(new Error("read timed out")));
    secure.on("data", (chunk: Buffer) => chunks.push(chunk));
    secure.on("error", reject);
    secure.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const status = Number(raw.split(" ")[1] ?? 0);
      const separator = raw.indexOf("\r\n\r\n");
      resolve({
        status,
        body_prefix: (separator === -1 ? "" : raw.slice(separator + 4)).slice(0, 200),
      });
    });
  });
}

export async function postThroughProxy(
  url: string,
  body: string,
  { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<EgressResult> {
  // The agent's "send it to a website" action: the same tunnel, the same
  // trust rules, one different verb. Whether the tunnel opens at all is
  // SecureProxy's decision, taken before this is called.
  assertVerificationEnabled();
  const target = new URL(url);
  const proxy = resolveProxy();
  if (!proxy) {
    throw new Error("no forward proxy is configured: this container has no other route out");
  }
  const port = Number(target.port || 443);
  const socket = await openTunnel(proxy, target.hostname, port, timeoutMs);
  const payload = Buffer.from(body, "utf8");
  const result = await new Promise<{ status: number; body_prefix: string }>((resolve, reject) => {
    const secure = tls.connect({ socket, servername: target.hostname }, () => {
      secure.write(
        `POST ${target.pathname}${target.search} HTTP/1.1\r\n` +
          `Host: ${target.hostname}\r\n` +
          "User-Agent: agentbox-starter\r\n" +
          "Content-Type: text/plain; charset=utf-8\r\n" +
          `Content-Length: ${payload.length}\r\n` +
          "Connection: close\r\n\r\n",
      );
      secure.write(payload);
    });
    const chunks: Buffer[] = [];
    secure.setTimeout(timeoutMs, () => secure.destroy(new Error("read timed out")));
    secure.on("data", (chunk: Buffer) => chunks.push(chunk));
    secure.on("error", reject);
    secure.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const status = Number(raw.split(" ")[1] ?? 0);
      const separator = raw.indexOf("\r\n\r\n");
      resolve({ status, body_prefix: (separator === -1 ? "" : raw.slice(separator + 4)).slice(0, 200) });
    });
  });
  return {
    url,
    status: result.status,
    body_prefix: result.body_prefix,
    proxy: proxyConfiguration(),
    trust: describeTrust() as unknown as Record<string, unknown>,
  };
}

export async function fetchThroughProxy(
  url: string,
  { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<EgressResult> {
  assertVerificationEnabled();
  const target = new URL(url);
  const proxy = resolveProxy();
  if (!proxy) {
    throw new Error(
      "no forward proxy is configured: this container has no other route out",
    );
  }
  const port = Number(target.port || 443);
  const socket = await openTunnel(proxy, target.hostname, port, timeoutMs);
  const result = await readOverTls(socket, target, timeoutMs);
  return {
    url,
    status: result.status,
    body_prefix: result.body_prefix,
    proxy: proxyConfiguration(),
    trust: describeTrust() as unknown as Record<string, unknown>,
  };
}
