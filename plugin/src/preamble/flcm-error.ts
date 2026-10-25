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
// Where a failure happened lives in fields, not in text someone has to slice back off: `call` is
// the public verb the agent called ("flcm.edit"), `path` the spec path inside it, `node` the layer
// it concerns. The message is composed from them, so a wrapper that learns the path later sets the
// field (locateFailure) instead of gluing text on the front. Only publicVerb sets `call`, so no
// throw site can name a verb the agent didn't write. The fields are read-only outside this module,
// so the message can't fall out of step with them.
//
// This module is the only plugin code allowed to read `.message` or construct a bare Error
// (eslint.config.js, the plugin block): keep foreign text quoted here, and nowhere else.

/**
 * Whose failure it is, which is what decides the agent's next move.
 *
 *   authoring        the call asked for something wrong; fixing the call fixes it
 *   figma            Figma can't or won't do it here — flcm detected the limit, or Figma refused a write
 *   concurrent-edit  the file was edited in Figma (by a person or another plugin) while this call ran
 *   run-ended        the run was cancelled or already replied, or this plugin can't run it, so nothing more starts
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
  /** The spec path inside the call, rooted at it or not: "flcm.render.spec.children[1].fill", "fill". */
  readonly path?: string;
  readonly node?: FlcmErrorNode;
}

/** Where a failure happened, minus the layer: what a site knows before it has the node in hand. */
export type FlcmLocation = Omit<FlcmErrorSite, "node">;

export class FlcmError extends Error {
  readonly kind: FlcmErrorKind;
  /** The sentence itself, without the call and path the message leads with. */
  readonly reason: string;
  /** The public verb, set by publicVerb as the failure leaves it. */
  readonly call: string | undefined;
  readonly path: string | undefined;
  readonly node: FlcmErrorNode | undefined;

  constructor(kind: FlcmErrorKind, reason: string, site: FlcmErrorSite = {}) {
    super(reason);
    this.name = "FlcmError";
    this.kind = kind;
    this.reason = reason;
    this.call = undefined;
    this.path = site.path;
    this.node = site.node;
    this.message = composeMessage(this);
  }
}

function composeMessage(error: FlcmError): string {
  const within = error.kind === "internal" ? withSentence(messageWithinCall(error), FLCM_BUG_ADVICE) : messageWithinCall(error);
  return error.call === undefined ? within : error.call + ": " + within;
}

/**
 * The message minus its leading call, said from inside `within`: for a caller that already names
 * where the failure is (an editMany entry line names its entry).
 */
export function messageWithinCall(error: FlcmError, within: string | undefined = error.call): string {
  const path = error.path === undefined ? undefined : pathWithin(error.path, within);
  const node = error.node === undefined ? undefined : describeNodeIdentity(error.node);
  const where = node !== undefined && path !== undefined ? node + " at " + path : node ?? path;
  return where === undefined ? error.reason : where + ": " + error.reason;
}

// Spec paths are rooted at the call ("flcm.render.spec.children[0]"), which the message already
// leads with, so the path is said from inside it ("spec.children[0]").
function pathWithin(path: string, within: string | undefined): string | undefined {
  if (within === undefined || !path.startsWith(within)) return path;
  const rest = path.slice(within.length);
  return rest === "" ? undefined : rest.startsWith(".") ? rest.slice(1) : rest.startsWith("[") ? rest : path;
}

// Said once, here, for every internal-kind error, so the sites state only what went wrong. The
// feedback tool (fig-74) adds its "report it with …" line to this sentence and nowhere else.
const FLCM_BUG_ADVICE = "This is a bug in flcm, not in your script. Try the change another way.";

/** A live layer as an error's node field. */
export function errorNodeOf(node: { type: string; name: string; id: string }): FlcmErrorNode {
  return { type: node.type, name: node.name, id: node.id };
}

/** A layer as every message names it: its type, then its name and id where known. */
export function describeNodeIdentity(node: FlcmErrorNode): string {
  return node.type + (node.name === undefined ? "" : " " + JSON.stringify(node.name)) + (node.id === undefined ? "" : " (id " + JSON.stringify(node.id) + ")");
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
  fields.path ??= site.path;
  fields.node ??= site.node;
  error.message = composeMessage(error);
  return error;
}

// A reason that lists lines under a header sentence (editMany's entries, a call's unmet values)
// takes a new sentence on the header, not on its last listed line.
function withSentence(text: string, sentence: string): string {
  const header = text.indexOf("\n");
  const head = header === -1 ? text : text.slice(0, header);
  return head + (/[.!?)]$/.test(head) ? " " : ". ") + sentence + (header === -1 ? "" : text.slice(header));
}

/** Append a sentence to a failure's reason, keeping its kind, site and identity. */
export function appendToFailure(cause: unknown, sentence: string): FlcmError {
  const error = asFlcmError(cause);
  (error as WritableFlcmFields).reason = withSentence(error.reason, sentence);
  error.message = composeMessage(error);
  return error;
}

/** Figma (or the platform) threw it, not flcm: the one type the "Figma refused" wording keys on. */
export class FigmaRefusalError extends FlcmError {
  /** What Figma threw, for a site that words the refusal around the layer it was writing. */
  readonly thrown: unknown;

  constructor(cause: unknown) {
    super("figma", describeFigmaRefusal(cause, "") + " Re-run the call; if it fails again, try the change another way.");
    this.thrown = cause;
  }
}

/**
 * What Figma said when it threw, quoted: its own wording names the setter ("in set_fills: …"). A
 * bare `undefined` or `null` has no wording to quote, so it says that instead of "undefined".
 * `subject` is what Figma refused ("a change to this layer"), or "" for a refusal of no known kind.
 */
export function describeFigmaRefusal(cause: unknown, subject: string): string {
  if (cause instanceof FigmaRefusalError) return describeFigmaRefusal(cause.thrown, subject);
  if (cause == null) return "Figma failed" + (subject ? " on " + subject : "") + " without saying why (it threw " + String(cause) + ").";
  return "Figma refused" + (subject ? " " + subject : "") + ": " + JSON.stringify(describeFailure(cause)) + ".";
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

/**
 * An error as the agent sees it: name, message, and only the frames from the agent's own code. The
 * sandbox names every eval'd frame `<input>` and the plugin's own frames `PLUGIN_<n>_SOURCE`; an
 * FlcmError's stack was already cut to the agent's call site at the public verb (publicVerb).
 */
export function formatFailureForAgent(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  // A parse error's frame has no function: "    at <input>:3".
  const frames = framesOf(cause.stack).filter((frame) => /[( ]<input>:\d/.test(frame));
  return [cause.name + ": " + cause.message, ...frames].join("\n");
}

// The engine's frame lines alone: V8 leads with an "Error: …" header, QuickJS doesn't.
function framesOf(stack: string | undefined): string[] {
  return (stack ?? "").split("\n").filter((line) => /^\s+at /.test(line));
}

/**
 * Wrap a public verb so every failure it raises names it and points at the agent's line, not at
 * flcm's insides. The one writer of `call`; the innermost verb wins. Calls `verb` synchronously: a mutating verb reserves its lock slot
 * at call time, and an await here would break the invocation order that guarantees.
 *
 * Only an FlcmError is touched. Anything else came from the agent's own code (a find predicate) or
 * from Figma outside any call flcm wraps, and is reported as thrown.
 */
export function publicVerb<F extends (...args: never[]) => unknown>(call: string, verb: F): F {
  return function (this: unknown, ...args: Parameters<F>) {
    // Read now: once the verb awaits, a failure's own stack holds only flcm's frames. The first
    // frame is this wrapper.
    const callerFrames = framesOf(new Error().stack).slice(1).join("\n");
    const fail = (cause: unknown): unknown => {
      // A verb called inside another (from a find predicate) already named itself and its line.
      if (!(cause instanceof FlcmError) || cause.call !== undefined) return cause;
      (cause as WritableFlcmFields).call = call;
      cause.message = composeMessage(cause);
      cause.stack = callerFrames;
      return cause;
    };
    let result: unknown;
    try {
      result = verb.apply(this, args);
    } catch (cause) {
      throw fail(cause);
    }
    return result instanceof Promise ? result.catch((cause: unknown) => { throw fail(cause); }) : result;
  } as F;
}

/**
 * The file was edited in Figma while this call ran — the one error for it, wherever it is noticed.
 * `changed` says what moved under the call, when the detecting site knows; it speaks of the error's
 * node, which the message already names. `unrolled` is the rare case where the call failed and the
 * edit landed inside the call's own undo history, so Figma's undo took none of it back: the call's
 * changes are still on the canvas (keptOnCanvas), which the lock's kept-sentence must not deny.
 */
export class ConcurrentEditError extends FlcmError {
  readonly changed: string | undefined;
  readonly keptOnCanvas: boolean;

  constructor(site: FlcmErrorSite & { changed?: string; unrolled?: unknown }) {
    // A call that failed BECAUSE of the edit (a style link on a node deleted meanwhile) says so once.
    const { unrolled } = site;
    const changed = site.changed ?? (unrolled instanceof ConcurrentEditError ? unrolled.changed : undefined);
    // `changed` speaks of the failed call's node ("it was deleted"), so the node comes along with it.
    if (site.node === undefined && unrolled instanceof FlcmError) site = { ...site, node: unrolled.node, path: site.path ?? unrolled.path };
    const edited = "the file was edited in Figma while this call ran" + (changed ? " (" + changed + ")" : "");
    super(
      "concurrent-edit",
      unrolled === undefined
        ? edited + ". Read the affected layers again, then re-run the call."
        : (unrolled instanceof ConcurrentEditError ? edited : "this call failed (" + describeFailure(unrolled) + "), and " + edited) +
            ", so Figma couldn't undo the call: its changes are still on the canvas. Read the affected layers again before you retry.",
      site,
    );
    this.changed = changed;
    this.keptOnCanvas = unrolled !== undefined;
  }
}
