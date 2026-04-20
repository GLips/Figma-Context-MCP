/**
 * Whether the host environment has any HTTP proxy var set.
 *
 * Single source of truth so `server.ts` (deciding whether to install
 * EnvHttpProxyAgent), `telemetry/client.ts` (reporting the proxy mode
 * dimension), and `figma.ts` (403 error hints) agree on what counts
 * as "proxy env".
 */
export function hasProxyEnv(): boolean {
  const names = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
  return names.some((n) => !!process.env[n] || !!process.env[n.toLowerCase()]);
}

/**
 * Which dispatcher is installed on the global fetch.
 *
 * `env` mode means EnvHttpProxyAgent is routing: a specific request may
 * still go direct when NO_PROXY matches. Consumers should treat this as
 * configuration state, not as "was this request proxied."
 */
export type ProxyMode = "none" | "explicit" | "env";

let currentMode: ProxyMode = "none";

export function setProxyMode(mode: ProxyMode): void {
  currentMode = mode;
}

export function proxyMode(): ProxyMode {
  return currentMode;
}
