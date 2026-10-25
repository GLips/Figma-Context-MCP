/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The prelude every props-taking entry runs: read-shape words judged by their disposition, input
// aliases folded, compressed-read refs caught, then the closed-set gate. Node compilers take only its
// output (`Accepted`), so no entry can skip it; pure value guards stay in the compilers.
import { normalizeInputAliases } from "./input-aliases.js";
import { rejectUnknownKeys, own, type UnknownKeyOptions } from "./validate.js";
import { FlcmError } from "./flcm-error.js";
import {
  WORD_GROUPS, LAYOUT_WORD_DISPOSITIONS, LAYOUT_VOCABULARY, aNodeOfType, hasContainerLayout, nodeBagVocabulary, nodeWordDisposition, referenceSectionOfType,
} from "./vocabulary.js";

interface AuthoringEntry {
  /** The node kind the bag is authored FOR: a compiler's own type, or the live target's under edit. */
  type: string;
  verb: "create" | "edit";
  /** The entry's closed vocabulary — everything left after the identity words is judged by it. */
  known: ReadonlySet<string>;
  /** The bag's spec path, rooted at the call: "flcm.render.spec.children[0]", "flcm.edit". */
  path: string;
}

declare const ACCEPTED: unique symbol;
/** A props bag the prelude has judged. A node compiler's only input, so none can skip the prelude. */
export type Accepted<P> = P & { readonly [ACCEPTED]: true };

// THE refusal. Every "flcm has no word for this" message is built here, so the sentence and the
// remedy can't drift between the node-word gate and the layout-word gate.
function refuse(path: string, why: string): FlcmError {
  return new FlcmError("authoring", "flcm can't write this — " + why + ". Drop it, or use flcm.clone(target) for a faithful live copy.", { path });
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
  const owner = aNodeOfType(entry.type);
  const described: UnknownKeyOptions = { owner, reference: referenceSectionOfType(entry.type), vocabulary: nodeBagVocabulary(entry.type, entry.verb) };
  if (bag === null || typeof bag !== "object" || Array.isArray(bag)) rejectUnknownKeys(bag, entry.known, entry.path, described);
  const src = normalizeInputAliases(bag as Record<string, unknown>, entry.path, entry.type);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    const value = src[key];
    const disposition = nodeWordDisposition(key);
    if (disposition === "record" || disposition === "context") continue;
    // An explicitly-undefined read word is absence, not a claim (`{ ...node, children: undefined }`).
    if (value == null && disposition !== undefined && disposition !== "author") continue;
    if (typeof disposition === "object") throw refuse(entry.path + "." + key, disposition.refuse);
    if (key === "type") {
      if (value !== entry.type) {
        throw new FlcmError(
          "authoring",
          "the node is a " + String(value) + ", not a " + entry.type + ". " +
            (entry.verb === "create" ? "Use the node's own type." : "Edit the node it was read from, or pass only the fields to change."),
          { path: entry.path + ".type" },
        );
      }
      continue;
    }
    if (key === "children") {
      throw new FlcmError("authoring", "children belong in a placement spec or an instance slot override. Use flcm.append to change a tree and flcm.remove to delete nodes.", { path: entry.path + ".children" });
    }
    out[key] = readyAuthoredValue(key, value, entry.path);
  }
  for (const [axis, designed] of [["width", "designedWidth"], ["height", "designedHeight"]] as const) {
    if (out[axis] !== "contextual") continue;
    if (src[designed] == null) delete out[axis];
    else out[axis] = src[designed];
  }
  if (out.layout != null) {
    const layout = readyLayout(out.layout, entry.path + ".layout");
    const words: readonly string[] = hasContainerLayout(entry.type) ? WORD_GROUPS.layout : WORD_GROUPS.childLayout;
    rejectUnknownKeys(layout, new Set(words), entry.path + ".layout", { owner: owner + "'s layout", reference: "props", vocabulary: LAYOUT_VOCABULARY });
    out.layout = layout;
  }
  rejectUnknownKeys(out, entry.known, entry.path, described);
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

function readyAuthoredValue(key: string, value: unknown, at: string): unknown {
  switch (key) {
    case "text": return readyTextContent(value, at + ".text");
    case "textStyle": case "effects": case "fill": case "stroke": return assertNotCompressedRef(value, at + "." + key);
    default: return value;
  }
}

// Every style slot (fill/stroke/effects/layout/textStyle) is a REF string when the read was compressed,
// minted as `<prefix>_<8 hex>` (core/src/compress.ts). The exact mint shape is matched — not "any
// string" — because `fill: "#FFF"` is a paint, and only the ref shape is worth its own message: handed
// to a value parser it reads as a malformed value, not a wrong read mode.
const STYLE_REF = /^(layout|style|fill|effect)_[0-9a-f]{8}/;

function assertNotCompressedRef<T>(value: T, path: string): T {
  if (typeof value === "string" && STYLE_REF.test(value)) {
    throw new FlcmError(
      "authoring",
      'this is a styles-table reference (like "fill_a1b2c3d4"), not a value — it came from a compressed read. ' +
        "flcm.get returns the expanded shape with every value inline; re-read the node with flcm.get, or resolve the reference against the design's `styles` table first.",
      { path },
    );
  }
  return value;
}

// The layout bag keeps its key and its authorable words verbatim (`gap` is a metric the compiler
// parses, `padding` takes read's box shorthand directly); this only refuses the words with no flcm
// form. Unknown words are the gate's to name.
function readyLayout(raw: unknown, path: string): unknown {
  assertNotCompressedRef(raw, path);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const l: Record<string, unknown> = {};
  for (const word of Object.keys(raw)) {
    const value = (raw as Record<string, unknown>)[word];
    if (value == null) continue; // an explicitly-undefined word is absence, not a claim
    const disposition = own(LAYOUT_WORD_DISPOSITIONS, word);
    if (disposition && typeof disposition === "object") throw refuse(path + "." + word, disposition.refuse);
    l[word] = value;
  }
  return l;
}

// The read `text` field is already the canonical run model (a markdown string, or `[text, style]`
// tuples), so it re-authors verbatim. The one thing to intercept is a compressed run: a tuple whose
// style slot is a ref string rather than the delta.
function readyTextContent(raw: unknown, path: string): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((run, i) => {
    if (Array.isArray(run)) assertNotCompressedRef(run[1], path + "[" + i + "][1]");
    return run;
  });
}
