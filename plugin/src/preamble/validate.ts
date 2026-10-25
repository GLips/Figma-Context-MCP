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
import { isNodeWord, TYPE_BLIND_NODE_VOCABULARY, type FlcmReferenceSection, type WordVocabulary } from "./vocabulary.js";

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

/** How a refusal names a closed set of words: what one word is, who takes them, where they're all listed. */
export type WordSetDescription = {
  /** What one word of the set is called: "prop" (the default), "query key", "field". */
  noun?: string;
  /** What takes the set ("a FRAME", "a FRAME's layout"), where the path alone doesn't say. */
  owner?: string;
} & (
  /**
   * The reference section that lists the set. Required even of a set short enough to list in full,
   * so a set that grows past the cap never needs its call sites revisited.
   */
  | { reference: FlcmReferenceSection }
  /** Where a set the document defines (a component's properties) is listed, as a clause: "flcm.get(…) lists them". */
  | { listedBy: string }
);

// A set this short IS the answer, so a refusal lists it; a longer one would bury the fix in a dump
// of words, so the refusal points at the section that lists them instead.
const WORD_SET_LIST_CAP = 8;

// The sentence every closed-set refusal ends on, lowercase so a caller can lead with it after a dash.
function describeWordSet(allowed: ReadonlySet<string>, description: WordSetDescription): string {
  const { noun = "prop", owner } = description;
  if (allowed.size <= WORD_SET_LIST_CAP) return (owner ? owner + " takes only " : "the " + noun + "s here are ") + words(allowed) + ".";
  if ("listedBy" in description) return description.listedBy + ".";
  return "every " + noun + " " + (owner ? owner + " takes" : "here") + " is in the " + JSON.stringify(description.reference) + " section of the flcm reference.";
}

const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * `candidates` close to `word`, fewest edits first. A typo is about one edit per four letters; farther
 * is a different word ("foo" → "top" would mislead). One- and two-letter words match only whole. A
 * word inside a candidate, or around it, is close ("radius" → "borderRadius"), and so is one "/"-segment
 * of a token name ("blue" → "color/blue/500").
 */
export function closestWords(word: string, candidates: Iterable<string>): string[] {
  const want = word.toLowerCase();
  const reach = want.length <= 2 ? 0 : Math.max(1, Math.floor((want.length + 2) / 4));
  const scored: { name: string; distance: number }[] = [];
  for (const name of new Set(candidates)) {
    const have = name.toLowerCase();
    const segments = have.split("/");
    // A segment match ranks behind a whole-name match of the same distance.
    const distance = Math.min(nearness(want, have, reach), segments.length > 1 ? Math.min(...segments.map((s) => nearness(want, s, reach))) + 0.5 : Infinity);
    if (distance !== Infinity) scored.push({ name, distance });
  }
  return scored.sort((a, b) => a.distance - b.distance).map((s) => s.name);
}

// The edits between two words when they are close (within `reach`, or one is most of the other), else Infinity.
function nearness(want: string, have: string, reach: number): number {
  const distance = editDistance(want, have);
  // Containment counts only when the shorter word is most of the longer: "x" is inside half the
  // vocabulary, and "text" inside "textTransform" names a different prop.
  const [short, long] = have.length < want.length ? [have, want] : [want, have];
  const contains = short.length >= 3 && short.length * 2 >= long.length && long.includes(short);
  return distance <= reach || contains ? distance : Infinity;
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

export type UnknownKeyOptions = WordSetDescription & {
  /**
   * The NEGATIVE SPACE of a closed set — where the word you wanted lives, when the set itself is the
   * answer to "what can I say here" but not to "so where do I say the rest". Appended verbatim.
   */
  hint?: string;
  /** The canonical vocabulary the set is cut from, so a real word in the wrong place isn't spelled as a typo. */
  vocabulary?: WordVocabulary;
};

/**
 * The refusal of `unknown` words outside `allowed`, each judged by the vocabulary before any spelling:
 * a word a nested bag takes is sent there, a real word this owner lacks is refused as that (with why,
 * where the vocabulary says), and only the rest are typos, offered their closest allowed words. The
 * set itself closes the message, unless every word was only misplaced.
 */
export function unknownWordsMessage(unknown: readonly string[], allowed: ReadonlySet<string>, options: UnknownKeyOptions): string {
  const noun = options.noun ?? "prop";
  const { vocabulary } = options;
  const misspelled: string[] = [], notTaken: string[] = [], placed: string[] = [];
  // Foreign spellings sharing one explanation ("x", "y") are named in one clause.
  const foreign = new Map<string, string[]>();
  const nested = vocabulary?.nested ?? {};
  const takenBags = Object.keys(nested).filter((bag) => allowed.has(bag));
  let listed = false;
  for (const word of unknown) {
    const bag = takenBags.find((key) => nested[key].has(word));
    if (bag) {
      placed.push(JSON.stringify(word) + " goes in " + bag + ": { " + bag + ": { " + word + ": … } }.");
      continue;
    }
    const explanation = vocabulary?.foreign && Object.prototype.hasOwnProperty.call(vocabulary.foreign, word) ? vocabulary.foreign[word] : undefined;
    if (explanation) {
      foreign.set(explanation, [...(foreign.get(explanation) ?? []), word]);
      continue;
    }
    listed = true;
    if (!vocabulary?.every.has(word)) misspelled.push(word);
    else {
      const why = vocabulary.why?.(word);
      if (why) placed.push(takerOf(options, noun, [word]) + ": " + why + ".");
      else notTaken.push(word);
    }
  }
  for (const [explanation, spelled] of foreign) {
    placed.push(spelled.map((k) => JSON.stringify(k)).join(", ") + (spelled.length > 1 ? " are no flcm words: " : " is no flcm word: ") + explanation + ".");
  }
  const suggested = [...new Set(misspelled.flatMap((k) => nearestWord(k, allowed, takenBags.map((bag) => [bag, nested[bag]]))))];
  const others = [
    ...placed,
    ...(notTaken.length ? [takerOf(options, noun, notTaken) + "; drop " + (notTaken.length > 1 ? "them." : "it.")] : []),
  ];
  const set = listed ? describeWordSet(allowed, options) : undefined;
  const hint = options.hint ? " " + options.hint : "";
  // The first clause stays lowercase, continuing the caller's "verb: path:" lead.
  if (!misspelled.length) return [...others, ...(set ? [set] : [])].map((c, i) => (i === 0 ? c : sentence(c))).join(" ") + hint;
  // The unknown words lead with their own remedy, so no clause about another word reads as theirs.
  const lead = "unknown " + noun + (misspelled.length > 1 ? "s " : " ") + misspelled.map((k) => JSON.stringify(k)).join(", ") + " — " +
    (suggested.length ? "did you mean " + suggested.join(", ") + "?" : set);
  return [lead, ...others.map(sentence), ...(suggested.length && set ? [sentence(set)] : [])].join(" ") + hint;
}

// The closest word to `word` in `allowed`, or else in a bag this owner takes: `"padding" (in layout)`.
function nearestWord(word: string, allowed: ReadonlySet<string>, bags: readonly [string, ReadonlySet<string>][]): string[] {
  const inAllowed = closestWords(word, allowed)[0];
  if (inAllowed !== undefined) return [JSON.stringify(inAllowed)];
  for (const [bag, bagWords] of bags) {
    const inBag = closestWords(word, bagWords)[0];
    if (inBag !== undefined) return [JSON.stringify(inBag) + " (in " + bag + ")"];
  }
  return [];
}

// "a TEXT doesn't take the prop "strokeWidth"", or with no owner to name, "the prop "d" isn't taken here".
function takerOf(options: UnknownKeyOptions, noun: string, taken: readonly string[]): string {
  const label = noun + (taken.length > 1 ? "s " : " ") + taken.map((k) => JSON.stringify(k)).join(", ");
  return options.owner ? options.owner + " doesn't take the " + label : "the " + label + (taken.length > 1 ? " aren't" : " isn't") + " taken here";
}

// Fail loud when `obj` isn't a plain object, or on any own key outside `allowed`: the one gate every
// unknown-word refusal comes from (unknownWordsMessage). `path` is the bag's spec path. The non-object
// branch is a BACKSTOP that richer call-site guards pre-empt (pad's number form, find's did-you-mean).
// Sets come pre-built and messages are built only on throw, so the happy path allocates nothing.
export function rejectUnknownKeys(obj: unknown, allowed: ReadonlySet<string>, path: string, options: UnknownKeyOptions): void {
  const noun = options.noun ?? "prop";
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    // Object.keys on a string enumerates its character indices — without this branch a string
    // here rejects as unknown keys "0", "1", "2"…: every word true, none naming the actual
    // object-vs-value mistake.
    throw new FlcmError("authoring", `must be an object of ${noun}s — got ${showValue(obj)}. ${sentence(describeWordSet(allowed, options))}`, { path });
  }
  const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
  if (unknown.length) throw new FlcmError("authoring", unknownWordsMessage(unknown, allowed, options), { path });
}

// The pure, document-blind half of a DELTA's validation, run before any target is resolved (by
// flcm.edit, and by an instance's `overrides` entries at construction). It judges only words that are
// no node word at all (typos, foreign spellings): every node word waits for the typed prelude, which
// knows the target's type and so answers as create does. `known` is the caller's edit vocabulary.
export function rejectNonDeltaWords(changes: unknown, known: ReadonlySet<string>, path: string): void {
  if (changes == null || typeof changes !== "object") {
    throw new FlcmError("authoring", "the changes must be an object of props to apply — got " + showValue(changes) + ".", { path });
  }
  const unknown = Object.keys(changes).filter((word) => !isNodeWord(word));
  // A delta's words are node props, which the props section lists node type by node type.
  const described: WordSetDescription = { reference: "props" };
  if (unknown.length) throw new FlcmError("authoring", unknownWordsMessage(unknown, known, { ...described, vocabulary: TYPE_BLIND_NODE_VOCABULARY }), { path });
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
