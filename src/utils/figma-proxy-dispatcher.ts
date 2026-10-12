// Kept apart from proxy-env.ts so the embeddable read entry, which reads the proxy mode for its
// 403 hints, never imports undici or a way to install a process-wide dispatcher.
import { ProxyAgent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { hasProxyEnv, setProxyMode } from "./proxy-env.js";

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
    setProxyMode("explicit");
  } else if (!proxy && hasProxyEnv()) {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    setProxyMode("env");
  }
}
