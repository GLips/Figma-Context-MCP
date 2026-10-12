/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { HostTraceStage, NativeOperation } from "../protocol.js";
import { serverDeadlinePassed, withServerCall } from "./server-deadline.js";
// The host↔preamble interface — everything the preamble needs from the plugin that isn't `figma.*`.
//
// Why it's named and typed rather than a pair of loose free identifiers: once the flcm runtime ships
// from the SERVER (ADR-0010), this is the entire compatibility surface between an installed plugin
// and a newer server. The DSL itself can change freely — verbs, vocabulary, parsers, appliers all
// ride the server release train — but a change to THIS forces every user through a manual manifest
// re-import. So it stays deliberately tiny, and an incompatible change to it bumps PROTOCOL_VERSION.
//
// What earns a place here: only a service that needs plugin-owned state the sandbox can't see — the
// reverse bridge, run cancellation, or plugin-run storage. Read egress is NOT one: its policy is the
// preamble's (egress.ts), and the host reaches it as the factory's projectForEgress.
// Helpers, policy and anything derivable from `figma.*` stay in the shipped preamble, where they
// cost nothing to change.
//
// Both halves import this type, so renaming a method or changing its shape is a tsc error on BOTH
// sides. Only the binding name `__flcmHost` crosses the eval boundary no compiler can see — and its
// other end is the factory wrapper index.mjs writes around this bundle, which refuses to emit one
// that doesn't reference the name. Rename it here alone and the generator throws.
// Execution services are required. Diagnostic reporting is optional; diagnostics never affect
// execution or deadlines.
type NativeTraceStage = Extract<HostTraceStage, `native-${string}`>;

/**
 * Why a run was cancelled, which the refusal words for the agent: the server gave up on it (its
 * deadline passed), its server disconnected, or the human revoked the session's approval.
 */
export type RunCancelCause = "server" | "disconnected" | "revoked";

export interface FlcmHost {
  /** Retain one preamble-initialized object for this plugin run; never retain the initializer. */
  getSession(initialize: () => Record<string, unknown>): Record<string, unknown>;
  traceNative?(stage: NativeTraceStage, operation: NativeOperation): void;
  /**
   * Private transport for server-shipped verbs. Never expose this on flcm or session. Every call
   * goes through serverCall below: withServerCall (server-deadline.ts) keeps the run's clock from
   * counting server work as silence, and a finished runtime is refused before it asks.
   */
  callServer(capability: string, payload: unknown): Promise<unknown>;
  /** Why this run was cancelled, or null while it wasn't. Only the host sees a CANCEL, a disconnect
   * or a revoke arrive. */
  runCancellation(): RunCancelCause | null;
  /**
   * Has the run this runtime was built FOR already replied? A runtime is per request, but agent code
   * can outlive it — stash `flcm` on globalThis in one call and it is still callable in the next,
   * bound to a host whose run is gone. Only the host knows its own run settled.
   */
  isRunFinished(): boolean;
  /** When this run's RUN_STATE "running" was stamped, by the host's clock: the server's inactivity
   * deadline counts from this same instant (server-deadline.ts). */
  readonly runStartedAt: number;
}

// run-executor.ts passes the host as the PARAMETER of the eval'd async wrapper the preamble runs inside, so
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
 * The image adapter over the private server channel: one deduped round trip to the server for image bytes.
 *
 * Absence is FATAL — an image fill with no channel would silently paint nothing, so this throws and
 * names what's missing.
 */
export async function requestHostImages(urls: string[]): Promise<Record<string, string>> {
  const host = currentHost();
  if (!host) {
    throw new Error(
      "flcm.image: this runtime has no host (FlcmHost) — image fills need the live plugin bridge.",
    );
  }
  const payload = await serverCall(host, "flcm.image", "images.fetch", urls);
  if (!payload || typeof payload !== "object") {
    throw new Error("flcm.image: the server's image reply was malformed.");
  }
  // Image policy belongs in the server-shipped preamble, not the installed host.
  const images: Record<string, string> = Object.create(null);
  for (const [url, bytes] of Object.entries(payload)) {
    if (typeof bytes === "string") images[url] = bytes;
  }
  return images;
}

/** One unresolved comment thread's pin: the frame Figma anchored it to, and the offset inside it. */
export interface HostCommentPin {
  nodeId: string;
  x: number;
  y: number;
}

/**
 * The file's unresolved comment pins, over the private server channel, or null when they can't be had.
 *
 * Absence is QUIET, unlike images: counts decorate reads nobody asked to be about comments, so no host,
 * a token without the comments scope, or a failed fetch all just mean no counts.
 */
export async function requestHostCommentPins(fileKey: string): Promise<HostCommentPin[] | null> {
  const host = currentHost();
  if (!host) return null;
  try {
    const reply = await serverCall(host, "flcm.read", "comments.pins", { fileKey });
    const pins = (reply as { pins?: unknown } | null)?.pins;
    if (!Array.isArray(pins)) return null;
    return pins.filter(
      (pin): pin is HostCommentPin =>
        !!pin && typeof pin.nodeId === "string" && typeof pin.x === "number" && typeof pin.y === "number",
    );
  } catch {
    return null;
  }
}

/**
 * Why this run was cancelled, or null. Fails OPEN — no host means no cancellation, which is what
 * keeps the harness and unit tests (which never install one) running verbs normally.
 */
export function hostRunCancellation(): RunCancelCause | null {
  return currentHost()?.runCancellation() ?? null;
}

/**
 * Whether this run has gone silent past the server's inactivity deadline by its own clock — the
 * CANCEL may still be queued behind a run holding the thread (server-deadline.ts). Fails OPEN like
 * cancellation: with no host there is no server and no deadline.
 */
export function hostDeadlinePassed(): boolean {
  const host = currentHost();
  return host ? serverDeadlinePassed(host.runStartedAt) : false;
}

/**
 * Refuse when this runtime's own run has already replied: the agent kept `flcm` across calls (on
 * globalThis — session refuses functions). Nothing carries its reads out, nothing can cancel or wait
 * for its writes, and its server calls answer a request nobody holds. Fails OPEN like cancellation:
 * no host means no run to outlive. `action` names the verb the refusal is from.
 */
export function refuseIfRunFinished(action: string): void {
  if (!currentHost()?.isRunFinished()) return;
  throw new Error(
    action + ": this flcm belongs to an earlier call that has already finished and replied, so " +
      "it can no longer read, write or fetch. Use the flcm your current call was given (store ids " +
      "and specs in `session`, never flcm itself).",
  );
}

/** Every server call: refused from a finished runtime, and bracketed for the deadline clock. */
function serverCall(host: FlcmHost, action: string, capability: string, payload: unknown): Promise<unknown> {
  refuseIfRunFinished(action);
  return withServerCall(() => host.callServer(capability, payload));
}

/** Diagnostics must not change the result or rejection of a native operation. */
export function traceNative(stage: NativeTraceStage, operation: NativeOperation): void {
  try { currentHost()?.traceNative?.(stage, operation); } catch { /* Reporting is best effort. */ }
}

export async function awaitNative<T>(operation: NativeOperation, run: () => Promise<T>): Promise<T> {
  traceNative("native-start", operation);
  try {
    const value = await run();
    traceNative("native-end", operation);
    return value;
  } catch (error) {
    traceNative("native-error", operation);
    throw error;
  }
}

/** Host ownership supplies lifetime; the server-shipped initializer supplies data policy. */
export function hostSession(initialize: () => Record<string, unknown>): Record<string, unknown> {
  return currentHost()?.getSession(initialize) ?? initialize();
}
