/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { FLCM_ERROR_KINDS, RUN_INACTIVITY_DEADLINE_MS, type CallOperation, type FlcmErrorKind } from "../protocol.js";
import { FlcmError, describeFailure } from "./flcm-error.js";
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
// Execution services are required. Call reporting only feeds the run's status: it never changes a
// call's result and never counts as a sign of life, which only the server's handled heartbeat request is.

/**
 * Why a run may not continue, which the refusal words for the agent: the server gave up on it, its
 * server disconnected, the human revoked its project's grant on the file, or its thread handled no
 * server heartbeat for RUN_INACTIVITY_DEADLINE_MS (so it could not have heard a CANCEL either).
 */
export type RunCancelCause = "server" | "disconnected" | "revoked" | "unresponsive";

/** The host's handle on one reported call: opaque, and meaningful only to the run that issued it. */
export type CallToken = number;

export interface FlcmHost {
  /**
   * The run's agent session: retain one preamble-initialized object per session handle, for this
   * plugin run; never retain the initializer.
   */
  getSession(initialize: () => Record<string, unknown>): Record<string, unknown>;
  /**
   * A call the run's status should name while it is pending: an flcm verb or a top-level figma.*
   * method. The name is agent-controlled, so the host checks it (isCallOperation) and counts a bad
   * one without naming it; reporting never refuses the call.
   */
  callStarted(operation: CallOperation): CallToken;
  /** The call settled, returned or thrown. A token from another run, or settled twice, is ignored. */
  callSettled(token: CallToken): void;
  /**
   * Private transport for server-shipped verbs. Never expose this on flcm or session. Every call
   * goes through serverCall below, so a finished runtime is refused before it asks.
   */
  callServer(capability: string, payload: unknown): Promise<unknown>;
  /**
   * May this run continue? Why not, or null. A CHECK, not a getter: past the inactivity deadline
   * since the host last handled its server's heartbeat, it latches "unresponsive" for good, so a late tick after a
   * long block never revives the run. Asked before every verb and every figma.* access.
   */
  runCancellation(): RunCancelCause | null;
  /**
   * Call `listener` once when this run is cancelled (at once if it already is); the returned function
   * unsubscribes. A Figma call can stall with the plugin's timers stalled too, so this, driven by the
   * CANCEL message (or the heartbeat request that latches the watchdog), is the only thing that can end the wait (untilCancelled).
   */
  onCancelled(listener: (cause: RunCancelCause) => void): () => void;
  /**
   * Has the run this runtime was built FOR already replied? A runtime is per request, but agent code
   * can outlive it — stash `flcm` on globalThis in one call and it is still callable in the next,
   * bound to a host whose run is gone. Only the host knows its own run settled.
   */
  isRunFinished(): boolean;
}

// run-executor.ts passes the host as the PARAMETER of the eval'd async wrapper the preamble runs inside, so
// this resolves as a function argument — no globalThis dependency in QuickJS, and immune to bundler
// renaming. The harness and the preamble unit tests run in global scope instead (indirect eval /
// plain import) and install it on globalThis; both paths resolve this same free identifier.
declare const __flcmHost: FlcmHost | undefined;

// Absent wherever no host is installed — every preamble unit test and the dogfood harness. Those
// paths must stay alive, so this answers "is there one" rather than asserting there is; each caller
// below decides whether absence is fatal for what IT is doing.
/** The host of the run this preamble serves; one object per run. */
export function currentHost(): FlcmHost | undefined {
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
    throw new FlcmError("internal", "images can only be fetched inside a run in the Figma plugin, and this one has no connection to it.");
  }
  const payload = await serverCall(host, "images.fetch", urls);
  if (!payload || typeof payload !== "object") {
    throw new FlcmError("internal", "the server's reply to the image fetch was malformed.");
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
export async function requestHostCommentPins(): Promise<HostCommentPin[] | null> {
  const host = currentHost();
  if (!host) return null;
  try {
    // No file key: the server reads the pins of the document this run was admitted for.
    const reply = await serverCall(host, "comments.pins", {});
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
 * Refuse when this runtime's own run has already replied: the agent kept `flcm` across calls (on
 * globalThis — session refuses functions). Nothing carries its reads out, nothing can cancel or wait
 * for its writes, and its server calls answer a request nobody holds. Fails OPEN like cancellation:
 * no host means no run to outlive.
 */
export function refuseIfRunFinished(): void {
  if (!currentHost()?.isRunFinished()) return;
  throw new FlcmError(
    "run-ended",
    "this flcm belongs to an earlier call that has already finished and replied, so " +
      "it can no longer read, write or fetch. Use the flcm your current call was given (store ids " +
      "and specs in `session`, never flcm itself).",
  );
}

/**
 * Every server call: refused from a finished runtime, and failing only with an FlcmError, so no verb
 * mistakes the server's failure for Figma's.
 */
async function serverCall(host: FlcmHost, capability: string, payload: unknown): Promise<unknown> {
  refuseIfRunFinished();
  try {
    return await host.callServer(capability, payload);
  } catch (failure) {
    throw new FlcmError(capabilityFailureKind(failure), describeFailure(failure));
  }
}

/**
 * Whose failure a call's rejection is: the `kind` on its `detail`, which the installed host forwards
 * untouched from the server, or sets itself on a call it abandons (server-calls.ts). Read as data,
 * never by class: the host is a separate bundle whose FlcmError this preamble's instanceof can't see.
 * A failure that names none is the server's bug, since every capability decides whose failure it raised.
 */
function capabilityFailureKind(failure: unknown): FlcmErrorKind {
  const detail = (failure as { detail?: unknown }).detail;
  const kind = detail !== null && typeof detail === "object" ? (detail as { kind?: unknown }).kind : undefined;
  return FLCM_ERROR_KINDS.find((known) => known === kind) ?? "internal";
}

/**
 * Run `call` reported to the host as pending until it returns, throws, or its promise settles. The
 * report never changes the call's result. With no host, the call just runs.
 */
export function reportCall<T>(operation: CallOperation, call: () => T): T {
  const host = currentHost();
  if (!host) return call();
  const token = host.callStarted(operation);
  let out: T;
  try {
    out = call();
  } catch (thrown) {
    host.callSettled(token);
    throw thrown;
  }
  // Watched on a branch of its own, so the caller still sees a rejection exactly as it was raised.
  if (isThenable(out)) out.then(() => host.callSettled(token), () => host.callSettled(token));
  else host.callSettled(token);
  return out;
}

/** Not `instanceof Promise`: Figma's promises needn't come from the sandbox's realm. */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && typeof value === "object" && typeof (value as { then?: unknown }).then === "function";
}

/**
 * `call`, unless the run is cancelled while it is pending: then a run-ended error naming
 * `operation`. The cancel listener goes once either settles, so settled calls leave none behind.
 */
export function untilCancelled<T>(operation: `figma.${string}`, call: PromiseLike<T>): Promise<T> {
  const host = currentHost();
  if (!host) return Promise.resolve(call);
  return new Promise<T>((resolve, reject) => {
    const unsubscribe = host.onCancelled((cause) =>
      reject(new FlcmError("run-ended", `${operation} was still pending when ${CANCELLED_BECAUSE[cause]}, so the run stops here.`)),
    );
    call.then(
      (value) => { unsubscribe(); resolve(value); },
      (error: unknown) => { unsubscribe(); reject(error); },
    );
  });
}

// The server doesn't say why it cancelled: its caller's time budget ran out, the caller gave up, or
// it heard no status from the plugin for the inactivity deadline.
export const CANCELLED_BECAUSE: Record<RunCancelCause, string> = {
  server: "the server cancelled this run",
  disconnected: "this run's server disconnected, so the run was cancelled",
  revoked: "the human revoked this project's grant on the file in Figma, so the run was cancelled",
  unresponsive:
    "the plugin handled no heartbeat from this run's server for " + RUN_INACTIVITY_DEADLINE_MS / 1000 + "s during this run",
};

/**
 * Await a Figma call, reported as pending, and abandoned if the run is cancelled first. Figma can leave a call
 * pending forever — loadFontAsync in a file whose window is in the background, seen live — with the
 * plugin's timers stalled too, so no timeout could end it; without this the run never replies and
 * every run behind it waits. The preamble's own scene access (scene-access.ts) routes every Figma
 * promise through here.
 */
export async function awaitNative<T>(operation: `figma.${string}`, run: () => PromiseLike<T>): Promise<T> {
  // Reported until Figma's own promise settles, not the race: a call abandoned here is still pending in Figma.
  return untilCancelled(operation, reportCall(operation, run));
}

/** Host ownership supplies lifetime; the server-shipped initializer supplies data policy. */
export function hostSession(initialize: () => Record<string, unknown>): Record<string, unknown> {
  return currentHost()?.getSession(initialize) ?? initialize();
}
