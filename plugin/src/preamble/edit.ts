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
//
// The pipeline is FIVE NAMED STAGES because `editMany` drives the same ones N times over one queue
// slot (invariant 4: a batch verb takes the lock once and rides the internal appliers, never the
// public verb). Their ORDER is the contract, not their bodies:
//
//   1. rejectNonDeltaWords    pure — no document read at all, so it can run for every entry first
//   2. compileEditPlan        the compile, which reads the LIVE node (font identity, wrap mode)
//   3. loadEditResources      the verb's ONLY awaits: one font load, one image request
//   4. assertEditPlanStillApplies  the live gates, AFTER the last await — plus proof that the node
//                             still exists and the facts stage 2 read still hold (readLiveTextFacts)
//   5a. applyEditPlanWrites     the sealed, commit-free span: everything that CHANGES the node
//   5b. settleEditPlanSizes      what still PRODUCES geometry: percent size, then the text clamp
//   5c. settleEditPlanPositions  what CONSUMES it: percent position and anchor, last of all
//
// 5a/5b/5c are one span, split only so a BATCH can run each across every entry before starting the
// next: a size read while another entry still has writes to land is a number about to move.
//
// Stage 4 is why stage 2's live reads are safe to make early. Loading fonts and image bytes
// suspends the run for a WS round trip while the user has the document open, and a batch stacks one
// suspension per entry — so a fact read before them is a guess by the time the seal lands. Rather
// than trust it, the compile SNAPSHOTS what it read and stage 4 re-reads and compares. (The
// dependency can't simply be reordered away: which fonts to load is derived from the live node.)

import { WriteProps, WriteType, WriteLayout, WriteTextStyle, Target, Handle, EDIT_TYPE_WORD_GROUPS, namesFontIdentity } from "./ir.js";
import { resolveTarget } from "./read.js";
import { enterMutatingVerb } from "./mutation-lock.js";
import { beginMutatingApply } from "./verb-error.js";
import {
  applyPaint, applySceneProps, mintHandle, applyLiveNodeLayout, settleLiveNodePercentSize,
  settleLiveNodePercentPosition, assertLayoutDeltaResolvable, applyTextProps, applyTextClamp,
  RenderResources, BatchLayoutDeltas,
} from "./bridge.js";
import { toFigmaEffects } from "./effects.js";
import { rejectUnknownKeys } from "./validate.js";
import { acceptReadSpellings, READ_FIELD_DISPOSITIONS, own } from "./read-spellings.js";
import { liveFontWords, loadFontsForTextEdits } from "./fonts.js";
import {
  KNOWN_KEYS, compileNodeLocalProps, compileSizeWords, compileContainerWords, compileLineLength,
  compileLineStroke, compilePaintWord, compileTextStyleWords, compileTextContent, assertLineClampCount,
  fetchImagesForTrees,
} from "./flcm.js";
import type { EditDelta, FrameProps, LineProps } from "./schema.js";

const SUBJECT = "flcm.edit";
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
export function rejectNonDeltaWords(changes: EditDelta, subject: string): void {
  if (changes == null || typeof changes !== "object") {
    throw new Error(subject + ": changes must be an object of props to apply — got " + JSON.stringify(changes) + ".");
  }
  if ("key" in changes) {
    throw new Error(
      subject + ": `key` is not editable — keys are set at creation and are how later calls address this node; re-keying could mint a duplicate address. Set `key` in the render that creates a node.",
    );
  }
  if ("x" in changes || "y" in changes) {
    throw new Error(
      subject + ": position is not spelled with bare x/y — use `absolute: { x, y }` to place the node out of flow (or `absolute: \"none\"` to return it to flow), and `pin` for how it responds to a parent resize.",
    );
  }
  // The read shape's own spellings (`fills`, `left`/`top`, `text`, …) are folded onto the edit words
  // in stage 2, where the live node's TYPE decides the fold (`fills` is `color` on a TEXT, `width` is
  // `length` on a LINE). They pass this document-blind gate unjudged; everything else is judged now,
  // against the edit vocabulary alone, so the message advertises one word per thing.
  const foreign: Record<string, unknown> = {};
  for (const key of Object.keys(changes)) {
    if (!own(READ_FIELD_DISPOSITIONS as Record<string, unknown>, key)) foreign[key] = (changes as Record<string, unknown>)[key];
  }
  rejectUnknownKeys(foreign, EDIT_KEYS, subject);
  assertDeltaNotEmpty(changes, subject);
}

function assertDeltaNotEmpty(changes: object, subject: string): void {
  if (Object.keys(changes).length === 0) {
    throw new Error(
      subject + ": the changes object is empty — nothing to apply (an empty edit would still mint an undo step). Editable words: " +
        [...EDIT_KEYS].join(", ") + ".",
    );
  }
}

// The per-type legality gate (prepare phase, after resolve and before the entry seal, so an illegal word rejects with
// zero writes). Returns the type's word set so the compile step can flag radius/clip from it.
function assertDeltaLegalForType(node: SceneNode, changes: EditDelta, subject: string): ReadonlySet<string> {
  const legal =
    (DELTA_KEYS_BY_TYPE as Record<string, ReadonlySet<string>>)[node.type] ||
    (node.type === "SLICE" ? SLICE_DELTA_KEYS : SHARED_DELTA_KEYS);
  for (const prop of Object.keys(changes)) {
    if (!legal.has(prop)) {
      throw new Error(
        subject + ": `" + prop + "` is not a " + node.type + " word — a " + node.type + " edit takes only " +
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
function enrichFontIdentity(ts: WriteTextStyle, node: TextNode, subject: string): WriteTextStyle {
  if (!namesFontIdentity(ts)) return ts;
  if (node.fontName === figma.mixed) {
    if (ts.fontFamily === undefined) {
      throw new Error(
        subject + ": this text mixes fonts (fontName is mixed), so a partial font change has no single base to resolve against — name textStyle.fontFamily in the same edit (unnamed weight resets to regular), or restyle spans via `content` runs.",
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
function compileDeltaPatch(changes: EditDelta, legal: ReadonlySet<string>, node: SceneNode, subject: string): WriteProps {
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
  if (changes.layout != null) Object.assign(layout, compileContainerWords(changes.layout as NonNullable<FrameProps["layout"]>, subject + ".layout"));
  if (Object.keys(layout).length) patch.layout = layout;
  if (node.type === "TEXT") compileTextDeltaWords(changes, patch, node as TextNode, subject);
  // Every named word compiled to nothing (all values null/undefined) — same hazard as `{}`: the
  // verb would mint an undo step for zero writes.
  if (Object.keys(patch).length === 0) {
    throw new Error(subject + ": the delta compiled to nothing — every value was null/undefined. Pass a real value, or omit the prop.");
  }
  return patch;
}

// The TEXT words: textStyle (create's own compile + live font-identity enrichment), lineClamp
// (create's shape gate; the bounded-width fact here is live-or-this-delta, not authored width),
// color (the text-fill sugar, exactly as flcm.text reads it), and content (create's own parser
// over an enriched base). Runs after the layout words land on the patch — lineClamp's gate reads
// the compiled sizing.
function compileTextDeltaWords(changes: EditDelta, patch: WriteProps, node: TextNode, subject: string): void {
  if (changes.textStyle != null) {
    const ts = compileTextStyleWords(changes.textStyle, subject + ".textStyle");
    if (Object.keys(ts).length) patch.textStyle = enrichFontIdentity(ts, node, subject);
    const clamp = changes.textStyle.lineClamp;
    if (clamp != null) {
      patch.maxLines = clamp === "none" ? clamp : assertLineClampCount(clamp, subject);
      // A clamp only bites against a bounded width (create rejects the same no-op). The bound is
      // whichever wins after this edit: a sizing named in the same delta, else the live wrap mode.
      if (patch.maxLines !== "none") {
        const named = patch.layout && patch.layout.sizing ? patch.layout.sizing.horizontal : undefined;
        const bounded = named !== undefined ? named !== "hug" : node.textAutoResize !== "WIDTH_AND_HEIGHT";
        if (!bounded) {
          throw new Error(
            subject + ': textStyle.lineClamp needs a bounded width to truncate against — this text hugs its width. Set width (a number, "fill", or "N%") in the same edit.',
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
      subject + ': width:"hug" would unbound a clamped text — its live lineClamp (' + node.maxLines +
        ') would never truncate again. Clear it in the same edit (textStyle: { lineClamp: "none" }) or keep a bounded width.',
    );
  }
  if (changes.color != null) patch.fills = compilePaintWord(changes.color, "color");
  if (changes.content != null) {
    const base = namesFontIdentity(patch.textStyle) ? patch.textStyle : liveBaseStyle(node);
    const compiled = compileTextContent(changes.content, base, changes.textStyle && changes.textStyle.boldWeight);
    // A styled run that changes font identity with no family anywhere (no run family, no delta
    // textStyle, mixed live base) would silently land in the DEFAULT family — reject instead.
    if (compiled.runs && compiled.runs.some((r) => namesFontIdentity(r.style) && r.style.fontFamily === undefined)) {
      throw new Error(
        subject + ": this text mixes fonts, so a styled run has no base family to resolve against — name textStyle.fontFamily in the same edit, or give each styled run its own fontFamily.",
      );
    }
    Object.assign(patch, compiled);
  }
}

// ---- The staged pipeline. `edit` drives it once; `editMany` drives each stage across the whole
// batch (edit-many.ts), which is what keeps every entry's gates reading the canvas at the same
// moment. Everything below is preamble-internal — the IIFE bundle exports only the public verbs. ----

// Every LIVE fact a compile reads off a TEXT node, as ONE comparable string — so recording the
// facts and comparing them are the same code, and a fact added here is re-verified by
// construction. (Only TEXT has any: the compile's other live read is `node.type`, which a live node
// cannot change.) The mixed branch spells out the RANGE fonts rather than a "mixed" token, because
// those are what the font preload reads — a retype that leaves the node mixed but swaps one range's
// font would otherwise slip past stage 4 and surface as a generic apply-time refusal instead.
function readLiveTextFacts(node: SceneNode): string | undefined {
  if (node.type !== "TEXT") return undefined;
  const t = node as TextNode;
  const font =
    t.fontName === figma.mixed
      ? t.getRangeAllFontNames(0, t.characters.length).map((f) => f.family + " " + f.style).join(",")
      : (t.fontName as FontName).family + " " + (t.fontName as FontName).style;
  return font + "|" + t.textAutoResize + "|" + t.maxLines;
}

/** One entry's compiled, ready-to-apply delta, plus what the compile read to produce it. */
export interface EditPlan { node: SceneNode; patch: WriteProps; liveTextFacts: string | undefined }

/** Stage 2 — compile against the live node, recording every mutable fact the compile consulted. */
export function compileEditPlan(node: SceneNode, changes: EditDelta, subject: string): EditPlan {
  changes = acceptReadSpellings(changes, { type: node.type, verb: "edit", known: EDIT_KEYS, subject }).props as EditDelta;
  // A delta that was ONLY read-shape identity (`{ id, type }`) folds to nothing — same refusal as an
  // empty object, now that the fold has run.
  assertDeltaNotEmpty(changes, subject);
  const legal = assertDeltaLegalForType(node, changes, subject);
  // Snapshot BEFORE the compile, so the recorded facts are the ones it goes on to read.
  const liveTextFacts = readLiveTextFacts(node);
  return { node, patch: compileDeltaPatch(changes, legal, node, subject), liveTextFacts };
}

/**
 * Stage 3 — the verb's resource awaits, and the only suspension between the compiles and the seal.
 * ONE font load and ONE image request however many entries there are: a batch is one verb, so it
 * owes one round trip, and every extra suspension is another instant the user can edit across.
 */
export async function loadEditResources(plans: readonly EditPlan[]): Promise<RenderResources> {
  const fonts = await loadFontsForTextEdits(plans);
  const images = await fetchImagesForTrees(plans.map((plan) => plan.patch));
  return { fonts, images };
}

/**
 * Stage 4 — everything that must read the document AFTER the verb's last await: the live-parent
 * layout gate, and proof that the facts the compile went on (font identity, wrap mode, live clamp)
 * survived the resource round trips. A mismatch is refused rather than papered over: the delta was
 * enriched against a font that is gone, or gated against a wrap that has changed, so applying it
 * would land something the agent never asked for. Zero writes either way.
 *
 * `deltas` is every layout delta the SAME verb is applying, by node id — a batch judges its entries
 * against the canvas it is creating, not the one it found.
 */
export function assertEditPlanStillApplies(plan: EditPlan, subject: string, deltas?: BatchLayoutDeltas): void {
  const { node } = plan;
  // EXISTENCE first, and unconditionally — it is the one live fact every delta depends on, including
  // the ones that read nothing else off the node. A node deleted during the round trip still accepts
  // writes (Figma detaches it rather than throwing on every setter), so without this a fill delta on
  // a deleted node reports success, mints a handle, and paints an object no longer on the canvas.
  if (node.removed) {
    throw new Error(
      subject + ": " + JSON.stringify(node.name) + " (id " + JSON.stringify(node.id) +
        ") was deleted while this call was loading fonts and images, so it is no longer on the canvas. Nothing was applied — re-run the call without it.",
    );
  }
  if (plan.liveTextFacts !== undefined && readLiveTextFacts(node) !== plan.liveTextFacts) {
    throw new Error(
      subject + ": the text of " + JSON.stringify(node.name) + " (id " + JSON.stringify(node.id) +
        ") changed while this call was loading fonts and images, so the delta was resolved against a node that no longer exists in that state. Nothing was applied — re-run the call.",
    );
  }
  // Layout words that only mean something against the live tree (a page parent, hug legality, the
  // hug-cycle percent) reject here like every other validation — zero writes on failure.
  if (plan.patch.layout) assertLayoutDeltaResolvable(node, plan.patch.layout, subject, deltas);
}

/**
 * The failure builder for one entry's apply, obtained ONCE for all three stages. The identity is
 * snapshotted here (see beginMutatingApply) and stage 5a may rename the node, so re-opening the
 * span per stage would report a name the rollback is about to erase.
 */
export type EditPlanFailure = (cause: unknown) => Error;

export function openEditPlanApply(verb: string, plan: EditPlan): EditPlanFailure {
  return beginMutatingApply(verb, plan.node);
}

/**
 * Stage 5a — the sealed, commit-free write span for one entry: everything that CHANGES the node.
 * No awaits, by the lock's contract.
 */
export function applyEditPlanWrites(fail: EditPlanFailure, { node, patch }: EditPlan, resources: RenderResources): void {
  try {
    applyPaint(node, patch, resources);
    applySceneProps(node, patch);
    // Text BEFORE layout — create's own order (buildText: characters, then applyLeafSize): an
    // anchor or percent in the same delta must resolve against the POST-reflow metrics, or a
    // center anchor lands off by the text-size change and only converges on a second run.
    // Fills still precede runs (applyPaint above).
    if (node.type === "TEXT") applyTextProps(node as TextNode, patch, resources);
    if (patch.layout) applyLiveNodeLayout(node, patch.layout);
  } catch (cause) {
    throw fail(cause);
  }
}

/**
 * Stage 5b — what still PRODUCES geometry after the writes: the percent SIZE, then the clamp that
 * clips against the wrap that size produced (the ordering `edit` has always had, and the reason
 * clamp isn't simply last).
 */
export function settleEditPlanSizes(fail: EditPlanFailure, { node, patch }: EditPlan): void {
  try {
    if (patch.layout) settleLiveNodePercentSize(node, patch.layout);
    if (node.type === "TEXT") applyTextClamp(node as TextNode, patch.maxLines);
  } catch (cause) {
    throw fail(cause);
  }
}

/**
 * Stage 5c — what CONSUMES geometry: percent position and anchor, which read the parent's realized
 * size and the node's own. Dead last, so in a batch they measure a canvas where every entry's
 * sizes have already settled.
 */
export function settleEditPlanPositions(fail: EditPlanFailure, { node, patch }: EditPlan): void {
  try {
    if (patch.layout) settleLiveNodePercentPosition(node, patch.layout);
  } catch (cause) {
    throw fail(cause);
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
      rejectNonDeltaWords(changes, SUBJECT);
      const plan = compileEditPlan(await resolveTarget(target), changes, SUBJECT);
      const resources = await loadEditResources([plan]);
      assertEditPlanStillApplies(plan, SUBJECT);
      return { plan, resources };
    },
    // Apply — the sealed span: all writes, no awaits.
    ({ plan, resources }) => {
      const fail = openEditPlanApply("edit", plan);
      applyEditPlanWrites(fail, plan, resources);
      settleEditPlanSizes(fail, plan);
      settleEditPlanPositions(fail, plan);
      return mintHandle(plan.node);
    },
  );
}
