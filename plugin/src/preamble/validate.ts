// validate — boundary validation shared across the preamble's agent-input surfaces. Pure (no
// figma.*), so it bundles into the QuickJS sandbox freely: one gate asserting an agent-supplied
// bag is a plain object whose every key is known, shared by the authoring constructors (flcm.ts),
// the locate queries (read.ts), and edit's delta — and, on top of it, the one prelude every
// props-taking entry runs so a `get` result spreads straight in.

// Every closed set in the preamble is indexed by an AGENT-SUPPLIED string, so a plain `table[key]`
// reaches Object.prototype: `{ type: "toString" }` would pass a type gate and `{ constructor: 1 }` a
// field gate, both silently. Own-property only — a closed set has to actually be closed.
export function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

const listKeys = (allowed: ReadonlySet<string>): string => [...allowed].map((k) => JSON.stringify(k)).join(", ");

// The reject must never crash while describing bad input — JSON.stringify itself throws on BigInt
// and cycles, and returns undefined for undefined/functions/symbols.
const showValue = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return "a " + typeof v;
  }
};

// Fail loud when `obj` isn't a plain object, or on any own key outside `allowed`, naming the
// offender(s) and the allowed set. ONE gate for every agent-input boundary in the preamble: the
// authoring constructors validate a `prop`, the locate verbs a `query key` — same scan, each
// boundary keeping its own vocabulary via `noun` and locating itself via `subject` ("flcm.frame",
// "flcm.text.textStyle", "flcm.find"). The non-object branch is the BACKSTOP: a call site with a
// richer shape to show (pad's number form, absolute's "none", find's did-you-mean) pre-empts it
// with its own tailored guard — keep those, don't fold them in here. The known set is passed
// pre-built (callers hold it at module scope) and the message lists are built only in the throw
// paths, so the happy path adds no per-call allocation.
export function rejectUnknownKeys(obj: unknown, allowed: ReadonlySet<string>, subject: string, noun = "prop"): void {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    // Object.keys on a string enumerates its character indices — without this branch a string
    // here rejects as unknown keys "0", "1", "2"…: every word true, none naming the actual
    // object-vs-value mistake.
    throw new Error(
      `flcm: ${subject} takes an object (${noun}s: ${listKeys(allowed)}) — got ${showValue(obj)}.`,
    );
  }
  const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
  if (unknown.length) {
    const label = noun + (unknown.length > 1 ? "s" : "");
    throw new Error(
      `flcm: unknown ${label} ${unknown.map((k) => JSON.stringify(k)).join(", ")} on ${subject} — ` +
        `${subject} takes only ${listKeys(allowed)}.`,
    );
  }
}

// The read shape carries a few words that are never authoring input, and every props-taking entry
// meets them the moment a `get` result is spread in. They are judged HERE, once, so they never join a
// constructor's vocabulary or the generated doc:
//   • `id` is the identity of the node that was READ. A build is a new node and an edit names its
//     target first, so it folds away — carrying it forward is what would make a copy look like a move.
//   • `type` must be the entry's own: a `get` result handed to the wrong constructor says so, and names
//     flcm.fromRead, the by-type dispatch.
//   • `children` are the read shape's own, not built nodes — fromRead recurses; a constructor can't.
//   • `designedWidth`/`designedHeight` carry a read ROOT's real px beside `width: "contextual"` — and
//     every `get` result is a root. Figma reports a top-level node FIXED against an absent parent, so
//     read rewrites the artifact and parks the number; authoring it AS that number is what makes the
//     pasted node look like the one that was read (dropping the axis would hand back a different size).
export const READ_ONLY_WORDS: ReadonlySet<string> = new Set(["id", "type", "children", "designedWidth", "designedHeight"]);

// The pure, document-blind half of a DELTA's validation (invariant 2's validate-then-mutate: this
// runs before any target is resolved, so a misspelled word reads "unknown prop" no matter what it
// targets). Shared by flcm.edit and by an instance's `overrides` entries, which are deltas in the
// same vocabulary judged at construction. `key` and bare `x`/`y` get steering messages ahead of
// the generic closed-set reject — they're the two mistakes an agent is most likely to make, and
// "unknown prop" would misdiagnose both. `known` is the caller's edit vocabulary (flcm.ts owns it).
export function rejectNonDeltaWords(changes: unknown, known: ReadonlySet<string>, subject: string): void {
  if (changes == null || typeof changes !== "object") {
    throw new Error(subject + ": changes must be an object of props to apply — got " + showValue(changes) + ".");
  }
  if ("key" in changes) {
    throw new Error(
      subject + ": `key` is not editable — keys are set at creation and are how later calls address this node; re-keying could mint a duplicate address. Set `key` in the render that creates a node.",
    );
  }
  if ("x" in changes || "y" in changes) {
    throw new Error(
      subject + ": position is not spelled with bare x/y — use `left`/`top` (naming either also lifts the node out of an auto-layout flow; `position: \"none\"` returns it), and `pin` for how it responds to a parent resize.",
    );
  }
  // The read shape's read-only words (`id`, `type`, `children`, a root's `designedWidth`) are judged
  // later, where the live node's TYPE is known. They pass this document-blind gate unjudged;
  // everything else is judged now, against the edit vocabulary alone.
  const foreign: Record<string, unknown> = {};
  for (const key of Object.keys(changes)) {
    if (!READ_ONLY_WORDS.has(key)) foreign[key] = (changes as Record<string, unknown>)[key];
  }
  rejectUnknownKeys(foreign, known, subject);
  if (Object.keys(changes).length === 0) {
    throw new Error(
      subject + ": the changes object is empty — nothing to apply (an empty edit would still mint an undo step). Editable words: " +
        [...known].join(", ") + ".",
    );
  }
}

export interface AuthoringEntry {
  /** The node kind the bag is authored FOR: a constructor's own type, or the live target's under edit. */
  type: string;
  verb: "create" | "edit";
  /** The entry's closed vocabulary — everything left after the identity words is judged by it. */
  known: ReadonlySet<string>;
  subject: string;
}

/**
 * The prelude every props-taking entry runs: fold the read shape's read-only words, then the closed-set
 * gate. Returns the bag with them gone. A non-object goes straight to the gate's own backstop.
 */
export function acceptAuthoringProps(bag: unknown, entry: AuthoringEntry): Record<string, unknown> {
  if (bag === null || typeof bag !== "object" || Array.isArray(bag)) rejectUnknownKeys(bag, entry.known, entry.subject);
  const src = bag as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    const value = src[key];
    if (key === "id" || key === "designedWidth" || key === "designedHeight") continue;
    // An explicitly-undefined read-only word is absence, not a claim (`{ ...node, children: undefined }`).
    if (value == null && READ_ONLY_WORDS.has(key)) continue;
    if (key === "type") {
      if (value !== entry.type) {
        throw new Error(
          entry.subject + ": the node is a " + String(value) + ", not a " + entry.type + ". " +
            (entry.verb === "create" ? "flcm.fromRead(node) builds by the node's own type." : "Edit the node it was read from, or pass only the fields to change."),
        );
      }
      continue;
    }
    if (key === "children") {
      throw new Error(
        entry.subject + ": `children` here are the read shape's own, not built nodes. " +
          (entry.verb === "create"
            ? "flcm.fromRead(node) rebuilds the whole subtree; or build the children with the constructors and pass them as the second argument."
            : entry.type === "SLOT"
              // The one node whose child list IS stated whole — but from the INSTANCE, where the
              // slot is a path, never as an edit of the SLOT node itself.
              ? "A slot's content is stated from its instance: flcm.edit(instance, { overrides: { \"<slotPath>\": { children: [ …nodes ] } } }) replaces it whole ([] empties it), and flcm.append(slot, node) adds to it."
              : "A tree changes through the structure verbs (append, move, remove), not an edit."),
      );
    }
    out[key] = value;
  }
  for (const [axis, designed] of [["width", "designedWidth"], ["height", "designedHeight"]] as const) {
    if (out[axis] !== "contextual") continue;
    if (src[designed] == null) delete out[axis];
    else out[axis] = src[designed];
  }
  rejectUnknownKeys(out, entry.known, entry.subject);
  return out;
}
