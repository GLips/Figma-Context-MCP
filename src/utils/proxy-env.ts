import { ProxyAgent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

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

export function proxyMode(): ProxyMode {
  return currentMode;
}

/**
 * Route every outbound Figma request (global fetch) for this process. The server and each REST CLI
 * command call this before their first request, so a proxy that works for one works for the other.
 *
 * Three outcomes: explicit proxy URL → ProxyAgent; no proxy but env vars set → EnvHttpProxyAgent;
 * otherwise Node's default (includes `--proxy=none`, which opts out of system-level proxy vars
 * misbehaving for api.figma.com — see issue #358).
 *
 * EnvHttpProxyAgent is deliberately NOT installed when no proxy vars are present, so a stale or
 * incidental var in the user's shell can't silently route Figma traffic through an intermediary.
 */
export function installFigmaProxyDispatcher(proxy: string | undefined): void {
  if (proxy && proxy !== "none") {
    setGlobalDispatcher(new ProxyAgent(proxy));
    currentMode = "explicit";
  } else if (!proxy && hasProxyEnv()) {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    currentMode = "env";
  }
}
