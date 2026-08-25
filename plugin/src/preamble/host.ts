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
// sides. Only the binding name `__flcmHost` crosses the eval boundary no compiler can see — and its
// other end is the factory wrapper index.mjs writes around this bundle, which refuses to emit one
// that doesn't reference the name. Rename it here alone and the generator throws.
// No optional members, deliberately: a host either exists or it doesn't, and one that exists
// answers for everything. That is what lets the accessors below check presence ONCE instead of
// probing each method — and what makes a partial host a test bug rather than a supported shape.
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
 * names what's missing.
 */
export function requestHostImages(urls: string[]): Promise<Record<string, string>> {
  const host = currentHost();
  if (!host) {
    throw new Error(
      "flcm.image: this runtime has no host (FlcmHost) — image fills need the live plugin bridge.",
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
  return host ? host.isRunCancelled() : false;
}
