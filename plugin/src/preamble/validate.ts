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
import { FlcmError } from "./flcm-error.js";
import { normalizeInputAliases } from "./input-aliases.js";
import { nodeWordDisposition } from "./vocabulary.js";

export function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

// The reject must never crash while describing bad input — JSON.stringify itself throws on BigInt
// and cycles, and returns undefined for undefined/functions/symbols.
export const showValue = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return "a " + typeof v;
  }
};

/**
 * A section of the flcm reference, by the id both channels take (get_flcm_reference's `sections`,
 * the `reference` CLI command). The server's section table is typed by this, so a renamed section
 * fails its typecheck rather than leaving an error pointing nowhere.
 */
export type FlcmReferenceSection =
  | "mental-model" | "layout" | "reads" | "verbs" | "props" | "annotations" | "values" | "edit" | "components" | "recipes";

/** How a refusal names a closed set of words: what one word is, who takes them, where they're all listed. */
export interface WordSetDescription {
  /** What one word of the set is called: "prop" (the default), "query key", "field". */
  noun?: string;
  /** What takes the set ("a FRAME", "a FRAME's layout"), where the path alone doesn't say. */
  owner?: string;
  /**
   * The reference section that lists the set. Required even of a set short enough to list in full,
   * so a set that grows past the cap never needs its call sites revisited.
   */
  reference: FlcmReferenceSection;
}

// A set this short IS the answer, so a refusal lists it; a longer one would bury the fix in a dump
// of words, so the refusal points at the section that lists them instead.
const WORD_SET_LIST_CAP = 8;

// The sentence every closed-set refusal ends on, lowercase so a caller can lead with it after a dash.
function describeWordSet(allowed: ReadonlySet<string>, { noun = "prop", owner, reference }: WordSetDescription): string {
  if (allowed.size <= WORD_SET_LIST_CAP) return (owner ? owner + " takes only " : "the " + noun + "s here are ") + words(allowed) + ".";
  return "every " + noun + " " + (owner ? owner + " takes" : "here") + " is in the " + JSON.stringify(reference) + " section of the flcm reference.";
}

const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * `candidates` close to `word`, fewest edits first. A typo is about one edit per four letters; anything
 * farther is a different word, and suggesting it ("foo" → "top") would steer the agent wrong. A word
 * inside a candidate, or around it, is close however many letters it lacks ("radius" → "borderRadius").
 */
export function closestWords(word: string, candidates: Iterable<string>): string[] {
  const want = word.toLowerCase();
  const reach = Math.max(1, Math.floor((want.length + 2) / 4));
  const scored: { name: string; distance: number }[] = [];
  for (const name of new Set(candidates)) {
    const have = name.toLowerCase();
    const distance = editDistance(want, have);
    // Containment counts only when the shorter word is most of the longer: "x" is inside half the
    // vocabulary, and "text" inside "textTransform" names a different prop.
    const [short, long] = have.length < want.length ? [have, want] : [want, have];
    const contains = short.length >= 3 && short.length * 2 >= long.length && long.includes(short);
    if (distance <= reach || contains) scored.push({ name, distance });
  }
  return scored.sort((a, b) => a.distance - b.distance).map((s) => s.name);
}

// Edits to turn `a` into `b`, a swap of two neighbours counting as one: "tpye" is one slip from "type".
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

export interface UnknownKeyOptions extends WordSetDescription {
  /**
   * The NEGATIVE SPACE of a closed set — where the word you wanted lives, when the set itself is the
   * answer to "what can I say here" but not to "so where do I say the rest". Appended verbatim.
   */
  hint?: string;
}

// Fail loud when `obj` isn't a plain object, or on any own key outside `allowed`: the one gate every
// unknown-word refusal in the preamble comes from. It names the offender(s), the closest allowed word
// to each, and the set itself (describeWordSet). `path` is the bag's spec path ("flcm.render.spec.textStyle",
// "flcm.find"). The non-object branch is the BACKSTOP: a call site with a richer shape to show (pad's
// number form, absolute's "none", find's did-you-mean) pre-empts it with its own tailored guard. The
// known set is passed pre-built (callers hold it at module scope) and messages are built only in the
// throw paths, so the happy path adds no per-call allocation.
export function rejectUnknownKeys(obj: unknown, allowed: ReadonlySet<string>, path: string, options: UnknownKeyOptions): void {
  const noun = options.noun ?? "prop";
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    // Object.keys on a string enumerates its character indices — without this branch a string
    // here rejects as unknown keys "0", "1", "2"…: every word true, none naming the actual
    // object-vs-value mistake.
    throw new FlcmError("authoring", `must be an object of ${noun}s — got ${showValue(obj)}. ${sentence(describeWordSet(allowed, options))}`, { path });
  }
  const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
  if (unknown.length) {
    const label = noun + (unknown.length > 1 ? "s" : "");
    const suggested = [...new Set(unknown.flatMap((k) => closestWords(k, allowed).slice(0, 1)))];
    const set = describeWordSet(allowed, options);
    throw new FlcmError(
      "authoring",
      `unknown ${label} ${unknown.map((k) => JSON.stringify(k)).join(", ")} — ` +
        (suggested.length ? `did you mean ${suggested.map((k) => JSON.stringify(k)).join(", ")}? ${sentence(set)}` : set) +
        (options.hint ? " " + options.hint : ""),
      { path },
    );
  }
}

// The pure, document-blind half of a DELTA's validation (invariant 2's validate-then-mutate: this
// runs before any target is resolved, so a misspelled word reads "unknown prop" no matter what it
// targets). Shared by flcm.edit and by an instance's `overrides` entries, which are deltas in the
// same vocabulary judged at construction. `key` and bare `x`/`y` get steering messages ahead of
// the generic closed-set reject — they're the two mistakes an agent is most likely to make, and
// "unknown prop" would misdiagnose both. `known` is the caller's edit vocabulary (the compilers own it);
// `path` is where the changes sit, rooted at the call ("flcm.edit", "flcm.editMany[2]").
export function rejectNonDeltaWords(changes: unknown, known: ReadonlySet<string>, path: string): void {
  if (changes == null || typeof changes !== "object") {
    throw new FlcmError("authoring", "the changes must be an object of props to apply — got " + showValue(changes) + ".", { path });
  }
  if ("key" in changes) {
    throw new FlcmError(
      "authoring",
      "`key` can't be edited — keys are set at creation and are how later calls address this node; re-keying could mint a duplicate address. Drop `key`, or set it in the render that creates the node.",
      { path: path + ".key" },
    );
  }
  if ("x" in changes || "y" in changes) {
    throw new FlcmError(
      "authoring",
      "position is not spelled with bare x/y — use `left`/`top` (naming either also lifts the node out of an auto-layout flow; `position: \"none\"` returns it), and `constraints` for how it responds to a parent resize.",
      { path: path + ("x" in changes ? ".x" : ".y") },
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
  // A delta's words are node props, which the props section lists node type by node type.
  const described: WordSetDescription = { reference: "props" };
  rejectUnknownKeys(normalizeInputAliases(foreign, path), known, path, described);
  assertDeltaNotEmpty(changes, known, path, described);
}

export function assertDeltaNotEmpty(changes: object, known: ReadonlySet<string>, path: string, described: WordSetDescription): void {
  if (Object.keys(changes).length === 0) {
    throw new FlcmError("authoring", "the changes object is empty, so there is nothing to apply. Name a prop to change: " + describeWordSet(known, described), { path });
  }
}

// Closed-set value checks: a word outside its set refuses with every legal spelling.
export function oneOf<T extends string>(set: ReadonlySet<T>, v: string): v is T {
  return set.has(v as T);
}

export function words(set: ReadonlySet<string>): string {
  return [...set].map((w) => '"' + w + '"').join(", ");
}

export function assertEnum<T extends string>(path: string, raw: unknown, set: ReadonlySet<T>): T {
  if (typeof raw !== "string" || !oneOf(set, raw)) {
    throw new FlcmError("authoring", "must be one of " + words(set) + " — got " + JSON.stringify(raw) + ".", { path });
  }
  return raw;
}
