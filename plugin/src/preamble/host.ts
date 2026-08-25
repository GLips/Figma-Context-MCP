// The host↔preamble interface — everything the preamble needs from the plugin that isn't `figma.*`.
//
// Why it's named and typed rather than a pair of loose free identifiers: once the flcm runtime ships
// from the SERVER (ADR-0010), this is the entire compatibility surface between an installed plugin
// and a newer server. The DSL itself can change freely — verbs, vocabulary, parsers, appliers all
// ride the server release train — but a change to THIS forces every user through a manual manifest
// re-import. So it stays deliberately tiny, and an incompatible change to it bumps PROTOCOL_VERSION.
//
// What earns a place here: only a service that needs plugin-owned state the sandbox can't see — the
// reverse bridge to the server (images) or the host's view of the run's lifecycle (cancellation).
// Helpers, policy and anything derivable from `figma.*` stay in the shipped preamble, where they
// cost nothing to change.
//
// Both halves import this type, so renaming a method or changing its shape is a tsc error on BOTH
// sides. Only the binding name `__flcmHost` crosses the eval boundary no compiler can see — one
// string, greped out of the built bundle by build.mjs, and the whole of the residual drift risk.
export interface FlcmHost {
  /** Fetch bytes for image urls through the server. The sandbox has no network of its own. */
  requestImages(urls: string[]): Promise<Record<string, string>>;
  /** Has the server cancelled this run? Only the host sees the CANCEL frame arrive. */
  isRunCancelled(): boolean;
}

// code.ts passes the host as the PARAMETER of the eval'd async wrapper the preamble runs inside, so
// this resolves as a function argument — no globalThis dependency in QuickJS, and immune to bundler
// renaming. The harness and the preamble unit tests run in global scope instead (indirect eval /
// plain import) and install it on globalThis; both paths resolve this same free identifier.
declare const __flcmHost: FlcmHost | undefined;

// Absent wherever no host is installed — every preamble unit test and the dogfood harness. Those
// paths must stay alive, so this answers "is there one" rather than asserting there is; each caller
// below decides whether absence is fatal for what IT is doing.
function currentHost(): FlcmHost | undefined {
  return typeof __flcmHost === "object" && __flcmHost !== null ? __flcmHost : undefined;
}

/**
 * The mid-run image channel (protocol 2): one deduped round trip to the server for image bytes.
 *
 * Absence is FATAL — an image fill with no channel would silently paint nothing, so this throws and
 * names the missing piece. Tests install a host carrying only the methods they exercise, which is
 * why the method is probed rather than assumed present on a host that exists.
 */
export function requestHostImages(urls: string[]): Promise<Record<string, string>> {
  const host = currentHost();
  if (!host || typeof host.requestImages !== "function") {
    throw new Error(
      "flcm.image: this runtime has no host image channel (FlcmHost.requestImages) — image fills need the live plugin bridge.",
    );
  }
  return host.requestImages(urls);
}

/**
 * Whether the server has cancelled this run. Fails OPEN — no host means no cancellation, which is
 * what keeps the harness and unit tests (which never install one) running verbs normally.
 */
export function hostRunCancelled(): boolean {
  const host = currentHost();
  return !!host && typeof host.isRunCancelled === "function" && host.isRunCancelled();
}
