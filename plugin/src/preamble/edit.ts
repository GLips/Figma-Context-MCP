// edit — the mutate verb: apply a partial delta to an existing live node (sibling to read.ts, the
// way render's live work lives in bridge.ts). ORCHESTRATION ONLY: validate → resolve → gate → apply
// → mint the updated Handle. The delta compiles through the same leaf parsers create uses
// (flcm.compileNodeLocalProps → css.ts) — never the constructors, whose job is to inject creation
// defaults (flcm.frame({ fill }) emits layout.mode "none"; riding it would turn a recolor into an
// auto-layout kill) — and every write lands through the bridge's exported appliers, never a second
// application path. The undo scaffold (entry seal / success commit / commit-then-undo rollback) is
// the lock's, not ours: see enterMutatingVerb in mutation-lock.ts.
//
// NOT exactly-once: the lock is run-scoped, and the server can re-send a run whose reply was lost
// after a first PENDING_APPROVAL — a resend is a new run that re-applies the delta. The delta
// vocabulary is ABSOLUTE values (a fill, an opacity — never "+10"), so a duplicate apply converges
// to the same canvas; the residue is a duplicate undo step, not divergent state. Keep it that way:
// a relative delta word would turn that accepted race into canvas corruption.
//
// Validation is APPLY-time-fresh: the whole delta pipeline — vocabulary, target resolution, the
// layout gates, clamp boundedness, font-identity enrichment, the font/image loads — runs as the
// verb's serialized PREPARE phase inside the lock's queue slot (reserved synchronously; edit() is
// a single enterMutatingVerb expression), so a run racing its own edits still has each edit's
// gates read the canvas exactly as that edit will find it. A prepare reject leaves zero undo
// residue; only the sealed apply span can mint a step.

import { WriteProps, WriteType, WriteLayout, WriteTextStyle, Target, Handle, EDIT_TYPE_WORD_GROUPS, namesFontIdentity } from "./ir.js";
import { resolveTarget } from "./read.js";
import { enterMutatingVerb } from "./mutation-lock.js";
import { mutatingVerbError } from "./verb-error.js";
import {
  applyPaint, applySceneProps, mintHandle, applyLiveNodeLayout, assertLayoutDeltaResolvable,
  applyTextProps, applyTextClamp,
} from "./bridge.js";
import { toFigmaEffects } from "./effects.js";
import { identityOf } from "./identity.js";
import { rejectUnknownKeys } from "./validate.js";
import { liveFontWords, loadFontsForTextEdit } from "./fonts.js";
import {
  KNOWN_KEYS, compileNodeLocalProps, compileSizeWords, compileContainerWords, compileLineLength,
  compileLineStroke, compilePaintWord, compileTextStyleWords, compileTextContent, assertLineClampCount,
  fetchTreeImages,
} from "./flcm.js";
import type { EditDelta, FrameProps, LineProps } from "./schema.js";

const EDIT_KEYS: ReadonlySet<string> = new Set(KNOWN_KEYS.edit);

// A create-verb's word groups, intersected with the current edit surface. The intersection is what
// makes later slices additive: when a word group's members join KNOWN_KEYS.edit (size/layout in 2.4,
// text in 2.5), each type's gate widens to create's exact shape with no edits here.
function editableWords(...groups: readonly (readonly string[])[]): ReadonlySet<string> {
  return new Set(groups.flat().filter((k) => EDIT_KEYS.has(k)));
}

// What each node type's delta may name — composed from EDIT_TYPE_WORD_GROUPS (ir.ts), the single
// source the generated per-type doc lists also render, so edit accepts on a node exactly the words
// create accepts for its type (invariant 1: one vocabulary, no permissive edit dialect — `fill` on
// a LINE rejects here the way flcm.line rejects it, instead of landing on a property Figma never
// renders). VECTOR uses flcm.path's words: an svg-born vector shares the type, but path's words
// are the only authored vocabulary the type has.
const DELTA_KEYS_BY_TYPE = Object.fromEntries(
  (Object.keys(EDIT_TYPE_WORD_GROUPS) as WriteType[]).map((t) => [
    t,
    editableWords(...EDIT_TYPE_WORD_GROUPS[t].map((g) => KNOWN_KEYS[g])),
  ]),
) as Record<WriteType, ReadonlySet<string>>;

// A node type flcm can't create (GROUP, INSTANCE, COMPONENT, …) takes the shared words (minus `key`,
// which isn't editable anywhere). Deliberately a conservative floor, not a mixin-derived ceiling:
// effects/rotation on a GROUP would land but wait for a deliberate widening.
const SHARED_DELTA_KEYS = editableWords(KNOWN_KEYS.shared);
// A SLICE is the one SceneNode with no MinimalBlendMixin — opacity/mixBlendMode don't exist on it,
// so accepting them would commit an undo step that changed nothing (the silent no-op the surface
// rejects everywhere else). The appliers' `in node` guards are belt for the same fact.
const SLICE_DELTA_KEYS = editableWords(["name", "visible", "locked"]);

// The pure, document-blind half of validation (invariant 2's validate-then-mutate: this runs before
// the target is even resolved, so a misspelled word reads "unknown prop" no matter what it targets).
// `key` and bare `x`/`y` get steering messages ahead of the generic closed-set reject — they're the
// two mistakes an agent is most likely to make, and "unknown prop" would misdiagnose both.
function rejectNonDeltaWords(changes: EditDelta): void {
  if (changes == null || typeof changes !== "object") {
    throw new Error("flcm.edit: changes must be an object of props to apply — got " + JSON.stringify(changes) + ".");
  }
  if ("key" in changes) {
    throw new Error(
      "flcm.edit: `key` is not editable — keys are set at creation and are how later calls address this node; re-keying could mint a duplicate address. Set `key` in the render that creates a node.",
    );
  }
  if ("x" in changes || "y" in changes) {
    throw new Error(
      "flcm.edit: position is not spelled with bare x/y — use `absolute: { x, y }` to place the node out of flow (or `absolute: \"none\"` to return it to flow), and `pin` for how it responds to a parent resize.",
    );
  }
  rejectUnknownKeys(changes, EDIT_KEYS, "flcm.edit");
  if (Object.keys(changes).length === 0) {
    throw new Error(
      "flcm.edit: the changes object is empty — nothing to apply (an empty edit would still mint an undo step). Editable words: " +
        [...EDIT_KEYS].join(", ") + ".",
    );
  }
}

// The per-type legality gate (prepare phase, after resolve and before the entry seal, so an illegal word rejects with
// zero writes). Returns the type's word set so the compile step can flag radius/clip from it.
function assertDeltaLegalForType(node: SceneNode, changes: EditDelta): ReadonlySet<string> {
  const legal =
    (DELTA_KEYS_BY_TYPE as Record<string, ReadonlySet<string>>)[node.type] ||
    (node.type === "SLICE" ? SLICE_DELTA_KEYS : SHARED_DELTA_KEYS);
  for (const prop of Object.keys(changes)) {
    if (!legal.has(prop)) {
      throw new Error(
        "flcm.edit: `" + prop + "` is not a " + node.type + " word — a " + node.type + " edit takes only " +
          [...legal].join(", ") + ".",
      );
    }
  }
  return legal;
}

// A textStyle delta naming SOME font-identity word resolves the rest of the triple against the
// LIVE node: `fontWeight: "bold"` on a Roboto text must stay Roboto — resolveFont keys the whole
// (family, weight, italic) triple, and an unenriched partial would key the default family. The
// live label decodes through fonts.ts's own grammar (liveFontWords — "Bold Italic" is weight AND
// slant in one string). A MIXED node has no single live identity to enrich from, so a partial
// triple rejects loud; naming fontFamily makes the delta a complete absolute reset and lands.
function enrichFontIdentity(ts: WriteTextStyle, node: TextNode): WriteTextStyle {
  if (!namesFontIdentity(ts)) return ts;
  if (node.fontName === figma.mixed) {
    if (ts.fontFamily === undefined) {
      throw new Error(
        "flcm.edit: this text mixes fonts (fontName is mixed), so a partial font change has no single base to resolve against — name textStyle.fontFamily in the same edit (unnamed weight resets to regular), or restyle spans via `content` runs.",
      );
    }
    return ts; // a family-anchored delta is an absolute whole-node reset — legal on mixed
  }
  return { ...liveFontWords(node.fontName as FontName), ...ts };
}

// The base style `content` runs layer over: the delta's own (enriched) font identity when it
// names one, else the live node's — so `content: ["a ", ["b", { fontWeight: "bold" }]]` bolds in
// the family the node actually uses. A mixed node has no single base; that case is gated by the
// caller (a styled run without a resolvable family would silently land in the default family).
function liveBaseStyle(node: TextNode): WriteTextStyle {
  return node.fontName === figma.mixed ? {} : liveFontWords(node.fontName as FontName);
}

// Compile the delta to a typed patch through create's own parsers, then pre-flight the one compiled
// form those parsers don't fully close: a raw EffectSpec[] passes normalizeEffects untouched, and an
// unknown kind would otherwise surface mid-apply as a fake "Figma refused". toFigmaEffects is pure
// (figma-free), so running it here keeps every vocabulary failure ahead of the first canvas write.
// Takes the LIVE node (not just its type): text words compile against live facts — font identity
// enrichment, the runs' base style, and lineClamp's bounded-width gate all read it.
function compileDeltaPatch(changes: EditDelta, legal: ReadonlySet<string>, node: SceneNode): WriteProps {
  const patch: WriteProps = {};
  compileNodeLocalProps(patch, changes, { radius: legal.has("borderRadius"), clip: legal.has("clip") });
  if (patch.effects) toFigmaEffects(patch.effects);
  // Layout words compile through the same helpers every constructor rides — never buildLayout,
  // whose creation default (omitted mode → "none") would turn a gap nudge into an auto-layout kill.
  const layout: WriteLayout = { ...(compileSizeWords(changes) || {}) };
  if (node.type === "LINE") {
    Object.assign(layout, compileLineLength(changes) || {});
    // flcm.line's own stroke compile carries the `stroke`-wins-over-`color` precedence; when only
    // `stroke` was named this re-lands what compileNodeLocalProps already wrote — same compile.
    const strokes = compileLineStroke(changes);
    if (strokes) patch.strokes = strokes;
  }
  if (changes.layout != null) Object.assign(layout, compileContainerWords(changes.layout as NonNullable<FrameProps["layout"]>, "flcm.edit.layout"));
  if (Object.keys(layout).length) patch.layout = layout;
  if (node.type === "TEXT") compileTextDeltaWords(changes, patch, node as TextNode);
  // Every named word compiled to nothing (all values null/undefined) — same hazard as `{}`: the
  // verb would mint an undo step for zero writes.
  if (Object.keys(patch).length === 0) {
    throw new Error("flcm.edit: the delta compiled to nothing — every value was null/undefined. Pass a real value, or omit the prop.");
  }
  return patch;
}

// The TEXT words: textStyle (create's own compile + live font-identity enrichment), lineClamp
// (create's shape gate; the bounded-width fact here is live-or-this-delta, not authored width),
// color (the text-fill sugar, exactly as flcm.text reads it), and content (create's own parser
// over an enriched base). Runs after the layout words land on the patch — lineClamp's gate reads
// the compiled sizing.
function compileTextDeltaWords(changes: EditDelta, patch: WriteProps, node: TextNode): void {
  if (changes.textStyle != null) {
    const ts = compileTextStyleWords(changes.textStyle, "flcm.edit.textStyle");
    if (Object.keys(ts).length) patch.textStyle = enrichFontIdentity(ts, node);
    const clamp = changes.textStyle.lineClamp;
    if (clamp != null) {
      patch.maxLines = clamp === "none" ? clamp : assertLineClampCount(clamp, "flcm.edit");
      // A clamp only bites against a bounded width (create rejects the same no-op). The bound is
      // whichever wins after this edit: a sizing named in the same delta, else the live wrap mode.
      if (patch.maxLines !== "none") {
        const named = patch.layout && patch.layout.sizing ? patch.layout.sizing.horizontal : undefined;
        const bounded = named !== undefined ? named !== "hug" : node.textAutoResize !== "WIDTH_AND_HEIGHT";
        if (!bounded) {
          throw new Error(
            'flcm.edit: textStyle.lineClamp needs a bounded width to truncate against — this text hugs its width. Set width (a number, "fill", or "N%") in the same edit.',
          );
        }
      }
    }
  }
  // The clamp gate's REVERSE: un-bounding the width while a live clamp stands would leave
  // maxLines set on a text that never wraps — the same silent no-op, reached from the other
  // side (clamp-then-hug instead of hug-then-clamp). Both orders must reject for the lock's
  // sequential-order guarantee to mean the bad state is unreachable.
  if (
    patch.layout && patch.layout.sizing && patch.layout.sizing.horizontal === "hug" &&
    node.maxLines != null && patch.maxLines !== "none"
  ) {
    throw new Error(
      'flcm.edit: width:"hug" would unbound a clamped text — its live lineClamp (' + node.maxLines +
        ') would never truncate again. Clear it in the same edit (textStyle: { lineClamp: "none" }) or keep a bounded width.',
    );
  }
  if (changes.color != null) patch.fills = compilePaintWord(changes.color, "color");
  if (changes.content != null) {
    const base = namesFontIdentity(patch.textStyle) ? patch.textStyle : liveBaseStyle(node);
    const compiled = compileTextContent(changes.content, base);
    // A styled run that changes font identity with no family anywhere (no run family, no delta
    // textStyle, mixed live base) would silently land in the DEFAULT family — reject instead.
    if (compiled.runs && compiled.runs.some((r) => namesFontIdentity(r.style) && r.style.fontFamily === undefined)) {
      throw new Error(
        "flcm.edit: this text mixes fonts, so a styled run has no base family to resolve against — name textStyle.fontFamily in the same edit, or give each styled run its own fontFamily.",
      );
    }
    Object.assign(patch, compiled);
  }
}

/**
 * flcm.edit(target, changes) — nudge an existing node. Resolves the target (key | id | flcm.id() |
 * handle), validates the whole delta before the first write, applies it through the bridge's
 * appliers under the mutation lock (one undo step; a Figma refusal rolls back commit-then-undo),
 * and returns the node's updated Handle with fresh geometry.
 */
// A single expression on purpose: the queue slot is reserved before edit() can possibly yield,
// which is the lock's invocation-order guarantee (see enterMutatingVerb) — don't add work above it.
export function edit(target: Target, changes: EditDelta): Promise<Handle> {
  return enterMutatingVerb(
    "edit",
    // Prepare — serialized, read-only, apply-time-fresh: every validation and canvas read
    // (vocabulary, resolve, gates, enrichment) and every await (fonts, images) lives here; a
    // throw rejects the verb with zero writes and zero undo residue.
    async () => {
      rejectNonDeltaWords(changes);
      const node = await resolveTarget(target);
      const legal = assertDeltaLegalForType(node, changes);
      const patch = compileDeltaPatch(changes, legal, node);
      // Layout words that only mean something against the live tree (a page parent, hug legality,
      // the hug-cycle percent) reject here like every other validation — zero writes on failure.
      if (patch.layout) assertLayoutDeltaResolvable(node, patch.layout);
      // Fonts gate every reflowing text mutation, not just characters — loaded before the seal,
      // like the image fetch below.
      const fonts = node.type === "TEXT" ? await loadFontsForTextEdit(node as TextNode, patch) : {};
      const images = await fetchTreeImages(patch);
      return { node, patch, fonts, images };
    },
    // Apply — the sealed span: all writes, no awaits.
    ({ node, patch, fonts, images }) => {
      // Snapshot identity before the first write: a delta that renames and then hits a refusal
      // would otherwise point at the NEW name — which the rollback is about to remove.
      const identity = identityOf(node);
      try {
        applyPaint(node, patch, { fonts, images });
        applySceneProps(node, patch);
        // Text BEFORE layout — create's own order (buildText: characters, then applyLeafSize): an
        // anchor or percent in the same delta must resolve against the POST-reflow metrics, or a
        // center anchor lands off by the text-size change and only converges on a second run.
        // Fills still precede runs (applyPaint above), and clamp goes last — it clips against the
        // wrap the sizing/content writes just produced.
        if (node.type === "TEXT") applyTextProps(node as TextNode, patch, { fonts, images });
        if (patch.layout) applyLiveNodeLayout(node, patch.layout);
        if (node.type === "TEXT") applyTextClamp(node as TextNode, patch.maxLines);
      } catch (cause) {
        throw mutatingVerbError("edit", identity, cause, node);
      }
      return mintHandle(node);
    },
  );
}
