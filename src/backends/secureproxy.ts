type Provider = "anthropic" | "google" | "openai";

const PROVIDERS: Record<
  Provider,
  { apiKeyEnv: string; baseUrlEnv: string; path: string }
> = {
  anthropic: {
    apiKeyEnv: "ANTHROPIC_API_KEY",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    path: "",
  },
  google: {
    apiKeyEnv: "GOOGLE_API_KEY",
    baseUrlEnv: "GOOGLE_API_BASE",
    path: "",
  },
  openai: {
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    path: "/v1",
  },
};

function managedByAgentBox(): boolean {
  return Boolean((process.env.AGENTBOX_APP_ID ?? "").trim()) ||
    process.env.KOBIL_SECUREPROXY_REQUIRED === "1";
}

export function configureSecureProxy(
  provider: Provider,
): { apiKey: string; baseURL: string } | null {
  const contract = PROVIDERS[provider];
  const proxyUrl = (process.env.KOBIL_SECUREPROXY_URL ?? "").trim();
  const virtualKey = (process.env.KOBIL_SECUREPROXY_API_KEY ?? "").trim();
  const required = managedByAgentBox() || Boolean(proxyUrl || virtualKey);
  if (!required) return null;
  if (!proxyUrl || !virtualKey) {
    throw new Error(
      "AgentBox-managed model calls require KOBIL_SECUREPROXY_URL and " +
        "KOBIL_SECUREPROXY_API_KEY; direct provider fallback is disabled.",
    );
  }

  const baseURL = `${proxyUrl.replace(/\/+$/, "")}${contract.path}`;
  process.env[contract.apiKeyEnv] = virtualKey;
  process.env[contract.baseUrlEnv] = baseURL;
  if (provider === "google") process.env.GOOGLE_GEMINI_BASE_URL = baseURL;
  return { apiKey: virtualKey, baseURL };
}
