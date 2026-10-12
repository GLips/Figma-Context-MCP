/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The prelude every props-taking entry runs: read-shape words judged by their disposition, input
// aliases folded, compressed-read refs caught, then the closed-set gate. Node compilers take only its
// output (`Accepted`), so no entry can skip it; pure value guards stay in the compilers.
import { normalizeInputAliases } from "./input-aliases.js";
import { rejectUnknownKeys, own } from "./validate.js";
import { WORD_GROUPS, LAYOUT_WORD_DISPOSITIONS, hasContainerLayout, nodeWordDisposition } from "./vocabulary.js";

interface AuthoringEntry {
  /** The node kind the bag is authored FOR: a compiler's own type, or the live target's under edit. */
  type: string;
  verb: "create" | "edit";
  /** The entry's closed vocabulary — everything left after the identity words is judged by it. */
  known: ReadonlySet<string>;
  subject: string;
}

declare const ACCEPTED: unique symbol;
/** A props bag the prelude has judged. A node compiler's only input, so none can skip the prelude. */
export type Accepted<P> = P & { readonly [ACCEPTED]: true };

export const CLONE_REMEDY = "Use flcm.clone(target) for a faithful live copy.";

// THE refusal. Every "flcm has no word for this" message is built here, so the sentence and the
// remedy can't drift between the node-word gate and the layout-word gate.
function refuse(subject: string, what: string, why: string): Error {
  return new Error(subject + ": `" + what + "` has no authored form — " + why + ". " + CLONE_REMEDY);
}

/** The bag without the words that describe a read rather than a change (vocabulary "record" words). */
export function withoutReadRecords(bag: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(bag).filter(([word]) => nodeWordDisposition(word) !== "record"));
}

/**
 * Fold the read shape's non-authoring words by their vocabulary disposition, then the closed-set gate.
 * Returns the bag with them gone. A non-object goes straight to the gate's own backstop.
 */
export function acceptAuthoringProps<P = Record<string, unknown>>(bag: unknown, entry: AuthoringEntry): Accepted<P> {
  if (bag === null || typeof bag !== "object" || Array.isArray(bag)) rejectUnknownKeys(bag, entry.known, entry.subject);
  const src = normalizeInputAliases(bag as Record<string, unknown>, entry.subject, entry.type);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    const value = src[key];
    const disposition = nodeWordDisposition(key);
    if (disposition === "record" || disposition === "context") continue;
    // An explicitly-undefined read word is absence, not a claim (`{ ...node, children: undefined }`).
    if (value == null && disposition !== undefined && disposition !== "author") continue;
    if (typeof disposition === "object") throw refuse(entry.subject, key, disposition.refuse);
    if (key === "type") {
      if (value !== entry.type) {
        throw new Error(
          entry.subject + ": the node is a " + String(value) + ", not a " + entry.type + ". " +
            (entry.verb === "create" ? "Use the node's own type." : "Edit the node it was read from, or pass only the fields to change."),
        );
      }
      continue;
    }
    if (key === "children") {
      throw new Error(entry.subject + ": children belong in a placement spec or an instance slot override. Use append to change a tree and remove to delete nodes.");
    }
    out[key] = readyAuthoredValue(key, value, entry.subject);
  }
  for (const [axis, designed] of [["width", "designedWidth"], ["height", "designedHeight"]] as const) {
    if (out[axis] !== "contextual") continue;
    if (src[designed] == null) delete out[axis];
    else out[axis] = src[designed];
  }
  if (out.layout != null) {
    const layout = readyLayout(out.layout, entry.subject);
    const words: readonly string[] = hasContainerLayout(entry.type) ? WORD_GROUPS.layout : WORD_GROUPS.childLayout;
    rejectUnknownKeys(layout, new Set(words), entry.subject + ".layout");
    out.layout = layout;
  }
  rejectUnknownKeys(out, entry.known, entry.subject);
  // Past the gate on purpose: beside a `"fill"` the designed size is the compile's page fallback
  // (WriteLayout.designedSize), inert unless a created root lands on a page. Create only — edit and
  // live moves reuse a delta whose destination isn't known here, so there it stays a dropped read-only word.
  if (entry.verb === "create") {
    for (const [axis, designed] of [["width", "designedWidth"], ["height", "designedHeight"]] as const) {
      if (out[axis] === "fill" && src[designed] != null) out[designed] = src[designed];
    }
  }
  return out as Accepted<P>;
}

// ---- values that keep their key ----

function readyAuthoredValue(key: string, value: unknown, subject: string): unknown {
  switch (key) {
    case "text": return readyTextContent(value, subject);
    case "textStyle": case "effects": case "fill": case "stroke": return assertNotCompressedRef(value, subject + "." + key);
    default: return value;
  }
}

// Every style slot (fill/stroke/effects/layout/textStyle) is a REF string when the read was compressed,
// minted as `<prefix>_<8 hex>` (core/src/compress.ts). The exact mint shape is matched — not "any
// string" — because `fill: "#FFF"` is a paint, and only the ref shape is worth its own message: handed
// to a value parser it reads as a malformed value, not a wrong read mode.
const STYLE_REF = /^(layout|style|fill|effect)_[0-9a-f]{8}/;

function assertNotCompressedRef<T>(value: T, field: string): T {
  if (typeof value === "string" && STYLE_REF.test(value)) {
    throw new Error(
      field + ' is a styles-table REFERENCE (like "fill_a1b2c3d4"), not a value — that read came from a COMPRESSED read. ' +
        "flcm.get returns the expanded shape with every value inline; re-read the node with flcm.get, or resolve the ref against the design's `styles` table first.",
    );
  }
  return value;
}

// The layout bag keeps its key and its authorable words verbatim (`gap` is a metric the compiler
// parses, `padding` takes read's box shorthand directly); this only refuses the words with no flcm
// form. Unknown words are the gate's to name.
function readyLayout(raw: unknown, subject: string): unknown {
  assertNotCompressedRef(raw, subject + ".layout");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const l: Record<string, unknown> = {};
  for (const word of Object.keys(raw)) {
    const value = (raw as Record<string, unknown>)[word];
    if (value == null) continue; // an explicitly-undefined word is absence, not a claim
    const disposition = own(LAYOUT_WORD_DISPOSITIONS, word);
    if (disposition && typeof disposition === "object") throw refuse(subject + ".layout", word, disposition.refuse);
    l[word] = value;
  }
  return l;
}

// The read `text` field is already the canonical run model (a markdown string, or `[text, style]`
// tuples), so it re-authors verbatim. The one thing to intercept is a compressed run: a tuple whose
// style slot is a ref string rather than the delta.
function readyTextContent(raw: unknown, subject: string): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((run, i) => {
    if (Array.isArray(run)) assertNotCompressedRef(run[1], subject + ".text run[" + i + "] style");
    return run;
  });
}
