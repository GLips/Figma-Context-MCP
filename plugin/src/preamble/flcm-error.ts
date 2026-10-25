/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// flcm-error — the one error type flcm throws, in the preamble and the plugin host alike. Code that
// needs to know WHY something failed branches on `kind`, never on message text: a reworded sentence
// must not change who gets blamed. Anything thrown that is NOT an FlcmError came from Figma or the
// platform, and that is decided by type alone: asFlcmError wraps it as a FigmaRefusalError, the one
// type that means Figma itself threw (isFigmaRefusal).
//
// Where a failure happened lives in fields, not in a prefix someone has to slice back off: `call`
// is the verb subject ("flcm.edit", "flcm.editMany[2]"), `path` the spec path inside it, `node` the
// layer it concerns. The message is composed from them, so a wrapper that learns the path later
// sets the field (locateFailure) instead of gluing text on the front. The fields are read-only
// outside this module, so the message can't fall out of step with them.
//
// This module is the only plugin code allowed to read `.message` or construct a bare Error
// (eslint.config.js, the plugin block): keep foreign text quoted here, and nowhere else.

/**
 * Whose failure it is, which is what decides the agent's next move.
 *
 *   authoring        the call asked for something wrong; fixing the call fixes it
 *   figma            Figma can't or won't do it here — flcm detected the limit, or Figma refused a write
 *   concurrent-edit  the file was edited in Figma (by a person or another plugin) while this call ran
 *   run-ended        the run was cancelled or already replied, so nothing more starts
 *   internal         flcm's own bug: the call was fine and flcm got it wrong
 */
export type FlcmErrorKind = "authoring" | "figma" | "concurrent-edit" | "run-ended" | "internal";

/** A layer an error concerns, in the fields a `find` hit carries so the agent re-targets without re-reading. */
export interface FlcmErrorNode {
  readonly type: string;
  readonly name?: string;
  readonly id?: string;
}

export interface FlcmErrorSite {
  /** The verb subject, as the agent's code named it: "flcm.edit", "flcm.editMany[2]". */
  readonly call?: string;
  /** The spec path inside the call: "root.children[1]". */
  readonly path?: string;
  readonly node?: FlcmErrorNode;
}

export class FlcmError extends Error {
  readonly kind: FlcmErrorKind;
  /** The sentence itself, without the call and path the message leads with. */
  readonly reason: string;
  readonly call: string | undefined;
  readonly path: string | undefined;
  readonly node: FlcmErrorNode | undefined;

  constructor(kind: FlcmErrorKind, reason: string, site: FlcmErrorSite = {}) {
    super(reason);
    this.name = "FlcmError";
    this.kind = kind;
    this.reason = reason;
    this.call = site.call;
    this.path = site.path;
    this.node = site.node;
    this.message = composeMessage(this);
  }
}

// The legality rules speak as a subject that is sometimes the node's spec path, so a path that
// repeats the call is said once.
function composeMessage(error: FlcmError): string {
  return error.call === undefined ? messageWithinCall(error) : error.call + ": " + messageWithinCall(error);
}

/** The message minus its leading call, for a caller that already names the call (an editMany entry line). */
export function messageWithinCall(error: FlcmError): string {
  return error.path === undefined || error.path === error.call ? error.reason : error.path + ": " + error.reason;
}

// The only writer of an error's fields: each change recomposes the message in the same step.
type WritableFlcmFields = { -readonly [K in "reason" | "call" | "path" | "node"]: FlcmError[K] };

/**
 * Fill in where `cause` happened, keeping whatever it already knows: the innermost site wins, since
 * that is the node that actually failed. Mutates and returns the same error, so its identity (which
 * the mutation lock tracks) survives. A foreign cause becomes a FigmaRefusalError at the site.
 */
export function locateFailure(cause: unknown, site: FlcmErrorSite): FlcmError {
  const error = asFlcmError(cause);
  const fields = error as WritableFlcmFields;
  fields.call ??= site.call;
  fields.path ??= site.path;
  fields.node ??= site.node;
  error.message = composeMessage(error);
  return error;
}

/** Append a sentence to a failure's reason, keeping its kind, site and identity. */
export function appendToFailure(cause: unknown, sentence: string): FlcmError {
  const error = asFlcmError(cause);
  (error as WritableFlcmFields).reason = error.reason + " " + sentence;
  error.message = composeMessage(error);
  return error;
}

/** Figma (or the platform) threw it, not flcm: the one type the "Figma refused" wording keys on. */
export class FigmaRefusalError extends FlcmError {
  constructor(cause: unknown) {
    // A foreign Error's message is Figma's own wording ("in set_fills: …"), quoted as-is.
    super("figma", describeFailure(cause));
  }
}

/** Any thrown value as an FlcmError: itself, or a FigmaRefusalError around what Figma threw. */
export function asFlcmError(cause: unknown): FlcmError {
  return cause instanceof FlcmError ? cause : new FigmaRefusalError(cause);
}

/** Whose failure any thrown value is. */
export function failureKindOf(cause: unknown): FlcmErrorKind {
  return cause instanceof FlcmError ? cause.kind : "figma";
}

/** Figma itself threw this, as opposed to flcm detecting a limit of Figma's (also kind "figma"). */
export function isFigmaRefusal(cause: unknown): boolean {
  return !(cause instanceof FlcmError) || cause instanceof FigmaRefusalError;
}

/** The text of any thrown value, for quoting in a message. Never branch on what it returns. */
export function describeFailure(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A failure's text for quoting inside `call`'s own message: a cause raised by the same call drops the call it would repeat. */
export function describeFailureWithinCall(cause: unknown, call: string | undefined): string {
  return cause instanceof FlcmError && cause.call === call ? messageWithinCall(cause) : describeFailure(cause);
}

/** An error as the agent's console shows it: name, message and, where the engine kept one, the stack. */
export function formatFailureForConsole(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  return cause.stack ? `${cause.name}: ${cause.message}\n${cause.stack}` : `${cause.name}: ${cause.message}`;
}

/**
 * The file was edited in Figma while this call ran — the one error for it, wherever it is noticed.
 * `changed` says what moved under the call, when the detecting site knows. `unrolled` is the rare
 * case where the call failed and the edit had joined its undo step, so the rollback took none of
 * it: the call's writes are still on the canvas.
 */
export class ConcurrentEditError extends FlcmError {
  readonly changed: string | undefined;

  constructor(site: FlcmErrorSite & { changed?: string; unrolled?: unknown }) {
    // A call that failed BECAUSE of the edit (a style link on a node deleted meanwhile) says so once.
    const { unrolled } = site;
    const changed = site.changed ?? (unrolled instanceof ConcurrentEditError ? unrolled.changed : undefined);
    const edited = "the file was edited in Figma while this call ran" + (changed ? " (" + changed + ")" : "");
    super(
      "concurrent-edit",
      unrolled === undefined
        ? edited + ". Nothing in this call was applied. Read the affected layers again, then re-run it."
        : (unrolled instanceof ConcurrentEditError ? edited : "this call failed (" + describeFailureWithinCall(unrolled, site.call) + "), and " + edited) +
            ", inside its undo step, so it couldn't be rolled back: its writes are still on the canvas. Read the affected layers again before you retry.",
      site,
    );
    this.changed = changed;
  }
}
