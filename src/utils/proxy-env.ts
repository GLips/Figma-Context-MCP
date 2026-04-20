/**
 * Which dispatcher is installed on the global fetch. `env` means
 * EnvHttpProxyAgent is routing, but a specific request may still go direct
 * when NO_PROXY matches — treat this as configuration state, not as
 * "was this request proxied."
 */
export type ProxyMode = "none" | "explicit" | "env";

const PROXY_ENV_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];

/**
 * Whether the host environment has any HTTP proxy var set (case-insensitive).
 * Shared so server.ts, telemetry/client.ts, and figma.ts agree on what counts
 * as "proxy env" — don't inline this check.
 */
export function hasProxyEnv(): boolean {
  return PROXY_ENV_VARS.some((n) => process.env[n] || process.env[n.toLowerCase()]);
}

let currentMode: ProxyMode = "none";

export function setProxyMode(mode: ProxyMode): void {
  currentMode = mode;
}

export function proxyMode(): ProxyMode {
  return currentMode;
}
