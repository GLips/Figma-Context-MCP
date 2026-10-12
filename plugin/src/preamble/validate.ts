/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// validate — boundary validation shared across the preamble's agent-input surfaces. Pure (no
// figma.*), so it bundles into the QuickJS sandbox freely: one gate asserting an agent-supplied
// bag is a plain object whose every key is known, shared by the authoring compilers (compile-*.ts),
// the locate queries (read.ts), and edit's delta — and, on top of it, the one prelude every
// props-taking entry runs so a `get` result spreads straight in.

// Every closed set in the preamble is indexed by an AGENT-SUPPLIED string, so a plain `table[key]`
// reaches Object.prototype: `{ type: "toString" }` would pass a type gate and `{ compiler: 1 }` a
// field gate, both silently. Own-property only — a closed set has to actually be closed.
import { normalizeInputAliases } from "./input-aliases.js";
import { nodeWordDisposition } from "./vocabulary.js";

export function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

const listKeys = (allowed: ReadonlySet<string>): string => [...allowed].map((k) => JSON.stringify(k)).join(", ");

// The reject must never crash while describing bad input — JSON.stringify itself throws on BigInt
// and cycles, and returns undefined for undefined/functions/symbols.
export const showValue = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return "a " + typeof v;
  }
};

// Fail loud when `obj` isn't a plain object, or on any own key outside `allowed`, naming the
// offender(s) and the allowed set. ONE gate for every agent-input boundary in the preamble: the
// authoring compilers validate a `prop`, the locate verbs a `query key` — same scan, each
// boundary keeping its own vocabulary via `noun` and locating itself via `subject` ("FRAME",
// "TEXT.textStyle", "flcm.find"). The non-object branch is the BACKSTOP: a call site with a
// richer shape to show (pad's number form, absolute's "none", find's did-you-mean) pre-empts it
// with its own tailored guard — keep those, don't fold them in here. The known set is passed
// pre-built (callers hold it at module scope) and the message lists are built only in the throw
// paths, so the happy path adds no per-call allocation.
// `hint` names the NEGATIVE SPACE of a closed set — where the word you wanted lives, when the set itself
// is the answer to "what can I say here" but not to "so where do I say the rest". Appended verbatim to the
// unknown-key message; omit it where the closed set really is the whole world.
export function rejectUnknownKeys(obj: unknown, allowed: ReadonlySet<string>, subject: string, noun = "prop", hint = ""): void {
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
        `${subject} takes only ${listKeys(allowed)}.${hint ? " " + hint : ""}`,
    );
  }
}


// The pure, document-blind half of a DELTA's validation (invariant 2's validate-then-mutate: this
// runs before any target is resolved, so a misspelled word reads "unknown prop" no matter what it
// targets). Shared by flcm.edit and by an instance's `overrides` entries, which are deltas in the
// same vocabulary judged at construction. `key` and bare `x`/`y` get steering messages ahead of
// the generic closed-set reject — they're the two mistakes an agent is most likely to make, and
// "unknown prop" would misdiagnose both. `known` is the caller's edit vocabulary (the compilers own it).
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
      subject + ": position is not spelled with bare x/y — use `left`/`top` (naming either also lifts the node out of an auto-layout flow; `position: \"none\"` returns it), and `constraints` for how it responds to a parent resize.",
    );
  }
  // The read shape's non-authoring words (`type`, `children`, a root's `designedWidth`, a refused
  // `strokeDashes`) are judged later, by the prelude, where the live node's TYPE is known. They pass
  // this document-blind gate unjudged; everything else is judged now, against the edit vocabulary alone.
  const foreign: Record<string, unknown> = {};
  for (const key of Object.keys(changes)) {
    const disposition = nodeWordDisposition(key);
    if (disposition === undefined || disposition === "author") foreign[key] = (changes as Record<string, unknown>)[key];
  }
  rejectUnknownKeys(normalizeInputAliases(foreign, subject), known, subject);
  assertDeltaNotEmpty(changes, known, subject);
}

export function assertDeltaNotEmpty(changes: object, known: ReadonlySet<string>, subject: string): void {
  if (Object.keys(changes).length === 0) {
    throw new Error(
      subject + ": the changes object is empty — nothing to apply (an empty edit would still mint an undo step). Editable words: " +
        [...known].join(", ") + ".",
    );
  }
}

// Closed-set value checks: a word outside its set refuses with every legal spelling.
export function oneOf<T extends string>(set: ReadonlySet<T>, v: string): v is T {
  return set.has(v as T);
}

export function words(set: ReadonlySet<string>): string {
  return [...set].map((w) => '"' + w + '"').join(", ");
}

export function assertEnum<T extends string>(name: string, raw: unknown, set: ReadonlySet<T>): T {
  if (typeof raw !== "string" || !oneOf(set, raw)) {
    throw new Error("flcm: " + name + " must be one of " + words(set) + " — got " + JSON.stringify(raw) + ".");
  }
  return raw;
}
