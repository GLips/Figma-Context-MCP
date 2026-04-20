/**
 * Whether the host environment has any HTTP proxy var set.
 *
 * Single source of truth so `server.ts` (deciding whether to install
 * EnvHttpProxyAgent) and `telemetry/client.ts` (reporting the
 * `proxy_env_set` dimension) agree on what counts as "proxy env".
 */
export function hasProxyEnv(): boolean {
  const names = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
  return names.some((n) => !!process.env[n] || !!process.env[n.toLowerCase()]);
}
