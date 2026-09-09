// edit-plan — the STAGES of the mutate pipeline, with no verb attached. Three callers drive them:
// `flcm.edit` (edit.ts) once, `flcm.editMany` (edit-many.ts) N times over one queue slot, and an
// INSTANCE's override deltas (instance.ts), which are edits of one sublayer each.
//
// The stages live here rather than beside the verb because instance.ts needs them and edit.ts needs
// instance.ts (an instance delta's component words resolve there) — a cycle if the verb and the
// stages shared a module. So: instance.ts → edit-plan.ts, edit.ts → { edit-plan.ts, instance.ts }.
//
// What the stages do: apply a partial delta to an existing live node (the read-side sibling is
// read.ts, the way render's live work lives in bridge.ts). ORCHESTRATION ONLY: validate → resolve →
// gate → apply. The delta compiles through the same leaf parsers create uses
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
//   3. loadEditResources      the verb's ONLY awaits: one font load, one image request, and the
//                             annotation categories the batch names (resolved, created if absent)
//   4. assertEditPlanStillApplies  the live gates, AFTER the last await — plus proof that the node
//                             still exists and the facts stage 2 read still hold (readLiveTextFacts)
//   5a. applyEditPlanWrites     the sealed, commit-free span: everything that CHANGES the node
//   5b. settleEditPlanSizes      what still PRODUCES geometry: percent size, then the text clamp
//   5c. settleEditPlanPositions  what CONSUMES it: percent position and anchor, last of all
//
// 5a/5b/5c are one span, split only so a BATCH can run each across every entry before starting the
// next: a size read while another entry still has writes to land is a number about to move.
//
// An INSTANCE delta adds no stage here. Its three component words are split off by stage 2 and left
// RAW on the plan (`instanceWords`); the verb resolves them through instance.ts and BRACKETS the
// stages above with the result — the retarget before 5a, the overrides after 5c (see edit.ts). They
// bracket rather than join because a swap or a variant change replaces the very sublayers the
// override paths name.
//
// A COMPONENT delta is split the same way (`componentWords` → component-edit.ts) and brackets the
// same stages: the DEFINITION words (`description`, `propertyDefinitions`) land before 5a, so a
// rename and a recolor of the same component are one undo step, and a sublayer's BINDING
// (`componentPropertyReferences`) lands right after 5a — the layer is what this delta makes it
// before it is wired to a property.
//
// Stage 4 is why stage 2's live reads are safe to make early. Loading fonts and image bytes
// suspends the run for a WS round trip while the user has the document open, and a batch stacks one
// suspension per entry — so a fact read before them is a guess by the time the seal lands. Rather
// than trust it, the compile SNAPSHOTS what it read and stage 4 re-reads and compares. (The
// dependency can't simply be reordered away: which fonts to load is derived from the live node.)

import {
  WriteNode, WriteProps, EditableType, WriteLayout, WriteTextStyle, InstanceEditWords, ComponentEditWords,
  ComponentPropertyBindingEdit, EDIT_TYPE_WORD_GROUPS, namesFontIdentity,
} from "./ir.js";
import { applyAnnotations, requestAnnotationCategories, requestTreeAnnotationCategories, resolveAnnotationCategories } from "./annotation-categories.js";
import { beginMutatingApply } from "./verb-error.js";
import {
  applyPaint, applySceneProps, applyLiveNodeLayout, settleLiveNodePercentSize,
  settleLiveNodePercentPosition, assertLayoutDeltaResolvable, applyTextProps, applyTextClamp,
  RenderResources, BatchLayoutDeltas, InstancePlan,
} from "./bridge.js";
import { toFigmaEffects } from "./effects.js";
import { acceptAuthoringProps, own, rejectNonDeltaWords as rejectNonDeltaWordsAgainst } from "./validate.js";
import { liveFontWords, loadFontsForTextEdits, EditFontNeed } from "./fonts.js";
import {
  KNOWN_KEYS, compileNodeLocalProps, compileSizeWords, compilePlacementWords, compileContainerWords,
  compileLineWidth, compileTextStyleWords, compileTextContent, assertLineClampCount, fetchImagesForTrees,
  compileComponentPropertyBag, compileOverrideBag, compileSwapTarget, compilePropertyDefinitionEditBag,
  INSTANCE_COMPONENT_WORDS, DOCUMENT_RESOLVED_EDIT_WORDS,
} from "./flcm.js";
import type { EditDelta, FrameProps } from "./schema.js";

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
  (Object.keys(EDIT_TYPE_WORD_GROUPS) as EditableType[]).map((t) => [
    t,
    editableWords(...EDIT_TYPE_WORD_GROUPS[t].map((g) => KNOWN_KEYS[g])),
  ]),
) as Record<EditableType, ReadonlySet<string>>;

// A node type with no per-type vocabulary (GROUP, SECTION, POLYGON, …) takes the shared words (minus `key`,
// which isn't editable anywhere). Deliberately a conservative floor, not a mixin-derived ceiling:
// effects/rotation on a GROUP would land but wait for a deliberate widening.
const SHARED_DELTA_KEYS = editableWords(KNOWN_KEYS.shared);
// A SLICE is the one SceneNode with no MinimalBlendMixin — opacity/mixBlendMode don't exist on it,
// so accepting them would commit an undo step that changed nothing (the silent no-op the surface
// rejects everywhere else). The appliers' `in node` guards are belt for the same fact.
const SLICE_DELTA_KEYS = editableWords(["name", "visible", "locked"]);

// Stage 1 — the document-blind gate (validate.ts owns it: an instance's `overrides` entries are
// deltas judged by the same rule at construction), bound to the edit vocabulary.
export function rejectNonDeltaWords(changes: EditDelta, subject: string): void {
  rejectNonDeltaWordsAgainst(changes, EDIT_KEYS, subject);
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
        subject + ": this text mixes fonts (fontName is mixed), so a partial font change has no single base to resolve against — name textStyle.fontFamily in the same edit (unnamed weight resets to regular), or restyle spans via `text` runs.",
      );
    }
    return ts; // a family-anchored delta is an absolute whole-node reset — legal on mixed
  }
  return { ...liveFontWords(node.fontName as FontName), ...ts };
}

// The base style `text` runs layer over: the delta's own (enriched) font identity when it
// names one, else the live node's — so `text: ["a ", ["b", { fontWeight: "bold" }]]` bolds in
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
  requestAnnotationCategories(patch.annotations);
  // Layout words compile through the same helpers every constructor rides — never buildLayout,
  // whose creation default (omitted mode → "none") would turn a gap nudge into an auto-layout kill.
  // A LINE's `width` is flcm.line's own fixed-only compile, not the sizing-intent one.
  const layout: WriteLayout =
    node.type === "LINE"
      ? { ...(compileLineWidth(changes) || {}), ...(compilePlacementWords(changes) || {}) }
      : { ...(compileSizeWords(changes) || {}) };
  if (changes.layout != null) Object.assign(layout, compileContainerWords(changes.layout as NonNullable<FrameProps["layout"]>, subject + ".layout"));
  if (Object.keys(layout).length) patch.layout = layout;
  if (node.type === "TEXT") compileTextDeltaWords(changes, patch, node as TextNode, subject);
  return patch;
}

// Split an INSTANCE delta's three component words off the delta: they are LIVE-DOCUMENT questions
// (which component a target names, which definition owns a property, which sublayer a path reaches),
// so the sync compile can only judge their SHAPE — the same shape gates flcm.instance runs, called
// here so the create and edit surfaces can't drift on what a property value or an override delta is.
// Returns undefined when the delta names none, so a plain recolor stays exactly what it was.
// (The per-type gate already rejected these words on every non-INSTANCE target.)
//
// A bag's CONTENT decides, not its presence: `componentProperties: {}` resolves to zero writes, so
// counting it as named would carry the delta past the compiled-to-nothing guard below and mint an
// undo step for nothing. The bags still compile — an empty one is legal shape, a non-object isn't.
function takeInstanceEditWords(changes: EditDelta, subject: string): InstanceEditWords | undefined {
  const words: InstanceEditWords = {};
  let named = false;
  const properties = own(changes as Record<string, unknown>, "componentProperties");
  if (properties != null) {
    const bag = compileComponentPropertyBag(properties, subject);
    if (Object.keys(bag).length) {
      words.componentProperties = bag;
      named = true;
    }
  }
  const overrides = own(changes as Record<string, unknown>, "overrides");
  if (overrides != null) {
    const bag = compileOverrideBag(overrides, subject);
    if (Object.keys(bag).length) {
      words.overrides = bag;
      named = true;
    }
  }
  const componentId = own(changes as Record<string, unknown>, "componentId");
  if (componentId != null) {
    words.componentId = compileSwapTarget(componentId, subject);
    named = true;
  }
  return named ? words : undefined;
}

// Split a delta's COMPONENT words off, exactly as takeInstanceEditWords splits the instance ones and
// for the same reason: which definition a bare property name reaches, which component owns the node,
// and what an instance-swap default resolves to are live-document questions the sync compile can
// only shape-check. Resolved by the verb's prepare (component-edit.ts) and applied around the
// node-local stages — definitions before them, the binding after.
//
// `description` is here rather than on the patch because there is no such WriteProps field: it is a
// COMPONENT/COMPONENT_SET-only word, and compileNodeLocalProps would silently drop it.
//
// A bag's CONTENT decides, not its presence (again as with the instance words): an empty
// `propertyDefinitions` or `componentPropertyReferences` resolves to zero writes, and counting it as
// named would carry the delta past the compiled-to-nothing guard and mint an undo step for nothing.
function takeComponentEditWords(changes: EditDelta, subject: string): ComponentEditWords | undefined {
  const words: ComponentEditWords = {};
  let named = false;
  const description = own(changes as Record<string, unknown>, "description");
  if (description != null) {
    if (typeof description !== "string") {
      throw new Error(subject + ".description must be a string — what Figma shows beside the component in the assets panel. Got " + JSON.stringify(description) + ".");
    }
    words.description = description;
    named = true;
  }
  const definitions = own(changes as Record<string, unknown>, "propertyDefinitions");
  if (definitions != null) {
    const bag = compilePropertyDefinitionEditBag(definitions, subject);
    if (Object.keys(bag).length) {
      words.propertyDefinitions = bag;
      named = true;
    }
  }
  const bindings = own(changes as Record<string, unknown>, "componentPropertyReferences");
  if (bindings != null) {
    // The bag's fields are judged against the LIVE node's type in prepare (component-edit.ts), which
    // is also where a name is resolved — here it is only "an object with something in it".
    if (typeof bindings !== "object" || Array.isArray(bindings)) {
      throw new Error(subject + '.componentPropertyReferences must be an object naming which component property drives which field, e.g. { text: "Label" } (or null to unbind) — got ' + JSON.stringify(bindings) + ".");
    }
    if (Object.keys(bindings).length) {
      words.componentPropertyReferences = bindings as ComponentPropertyBindingEdit;
      named = true;
    }
  }
  return named ? words : undefined;
}

// The delta minus the words a live pass resolves — what the node-local compile above judges. A
// shallow copy so the caller's own object is never mutated (it is the agent's, and editMany
// snapshots but doesn't own it).
function withoutDocumentResolvedWords(changes: EditDelta): EditDelta {
  const out: Record<string, unknown> = {};
  for (const word of Object.keys(changes)) {
    if (!DOCUMENT_RESOLVED_EDIT_WORDS.has(word)) out[word] = (changes as Record<string, unknown>)[word];
  }
  return out as EditDelta;
}

// The TEXT words: textStyle (create's own compile + live font-identity enrichment), lineClamp
// (create's shape gate; the bounded-width fact here is live-or-this-delta, not authored width),
// and text + boldWeight (create's own content parser over an enriched base). `fill` is not here: it
// is the shared paint word, landed by compileNodeLocalProps like every other node's. Runs after the
// layout words land on the patch — lineClamp's gate reads the compiled sizing.
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
  // `boldWeight` is a content convention (what `**` in `text` resolves to), not a property of the
  // live node — alone it would re-emphasize nothing, the silent no-op the surface rejects everywhere.
  if (changes.boldWeight != null && changes.text == null) {
    throw new Error(
      subject + ": `boldWeight` says what `**` in `text` resolves to, and this delta names no `text` — the live content would not be re-emphasized. Pass the content back as `text` with the new `boldWeight`, or drop it.",
    );
  }
  if (changes.text != null) {
    const base = namesFontIdentity(patch.textStyle) ? patch.textStyle : liveBaseStyle(node);
    const compiled = compileTextContent(changes.text, base, changes.boldWeight ?? undefined);
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

/**
 * One entry's compiled, ready-to-apply delta, plus what the compile read to produce it.
 *
 * `instanceWords` is the INSTANCE half, still RAW: only a live-document pass can resolve it, and the
 * compile is sync. The verb's prepare turns it into an `instance` plan (instance.ts) and the apply
 * span brackets the node-local stages with it — retarget before 5a, overrides after 5c.
 */
export interface EditPlan {
  node: SceneNode;
  patch: WriteProps;
  liveTextFacts: string | undefined;
  instanceWords?: InstanceEditWords;
  /** The COMPONENT half, still RAW — resolved by component-edit.ts in the verb's prepare. */
  componentWords?: ComponentEditWords;
}

/** Stage 2 — compile against the live node, recording every mutable fact the compile consulted. */
export function compileEditPlan(node: SceneNode, changes: EditDelta, subject: string): EditPlan {
  changes = acceptAuthoringProps(changes, { type: node.type, verb: "edit", known: EDIT_KEYS, subject }) as EditDelta;
  // A delta that was ONLY read-shape identity (`{ id, type }`) folds to nothing — same refusal as an
  // empty object, now that the prelude has run.
  assertDeltaNotEmpty(changes, subject);
  const legal = assertDeltaLegalForType(node, changes, subject);
  const instanceWords = takeInstanceEditWords(changes, subject);
  const componentWords = takeComponentEditWords(changes, subject);
  // Unconditional: an EMPTY component bag doesn't make `instanceWords`/`componentWords`, and it must
  // not reach the node-local compile either — `componentProperties` is not a word compileDeltaPatch knows.
  const nodeLocal = withoutDocumentResolvedWords(changes);
  // Snapshot BEFORE the compile, so the recorded facts are the ones it goes on to read.
  const liveTextFacts = readLiveTextFacts(node);
  const patch = Object.keys(nodeLocal).length ? compileDeltaPatch(nodeLocal, legal, node, subject) : {};
  // Every named word compiled to nothing (all values null/undefined, or an empty component bag) —
  // same hazard as `{}`: the verb would mint an undo step for zero writes. Instance and component
  // words that carry content have real work ahead of them either way, so they short-circuit it.
  if (!instanceWords && !componentWords && Object.keys(patch).length === 0) {
    throw new Error(subject + ": the delta compiled to nothing — every value was null, undefined, or an empty object. Pass a real value, or omit the prop.");
  }
  const plan: EditPlan = { node, patch, liveTextFacts };
  if (instanceWords) plan.instanceWords = instanceWords;
  if (componentWords) plan.componentWords = componentWords;
  return plan;
}

/**
 * What the INSTANCE specs a verb will build need loaded before its span: their plans (instance.ts
 * resolved them against the live component), the font needs of their override deltas, and the
 * SLOT CONTENT trees those overrides fill — spec trees in their own right, whose fonts and images
 * load exactly as a rendered tree's do and whose own nested instances are already in `plans`.
 * Produced by instance.ts for a rendered tree and for an instance delta alike; this module only
 * types it, because stage 3 below is what spends it.
 */
export interface InstanceNeeds {
  plans: Map<WriteNode, InstancePlan>;
  fontNeeds: EditFontNeed[];
  slotContentTrees: WriteNode[];
}

/**
 * Stage 3 — the verb's resource awaits, and the only suspension between the compiles and the seal.
 * ONE font load and ONE image request however many entries there are: a batch is one verb, so it
 * owes one round trip, and every extra suspension is another instant the user can edit across.
 *
 * `needs` is every INSTANCE entry's slot content: the one way a delta BUILDS nodes, so the one way
 * an edit's resources carry instance plans and tree fonts at all.
 */
export async function loadEditResources(plans: readonly EditPlan[], needs: readonly InstanceNeeds[] = []): Promise<RenderResources> {
  const trees: WriteNode[] = [];
  const instances = new Map<WriteNode, InstancePlan>();
  const fontNeeds: EditFontNeed[] = [];
  for (const need of needs) {
    trees.push(...need.slotContentTrees);
    fontNeeds.push(...need.fontNeeds);
    need.plans.forEach((plan, wn) => instances.set(wn, plan));
  }
  for (const tree of trees) requestTreeAnnotationCategories(tree);
  // Slot content is BUILT, so its fonts are a tree's, not a delta's — folded into the same load.
  const fonts = await loadFontsForTextEdits([...plans, ...fontNeeds], trees);
  const images = await fetchImagesForTrees([...plans.map((plan) => plan.patch), ...trees]);
  // Categories last of the three: resolving one can CREATE a file-scoped category, so a batch whose
  // font or image load was going to fail anyway never creates one to be cleaned up again. It lands
  // HERE, inside stage 3, so stage 4's live gates still run after the verb's every suspension.
  await resolveAnnotationCategories();
  return { fonts, images, instances };
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
 *
 * `becomesRowColumn` is the same projection one node deep: an INSTANCE delta that swaps or
 * re-variants takes the INCOMING component's auto-layout mode before its root words land, so its
 * `layout` words are legal or not by that mode, never the outgoing one's (instance.ts computes it).
 * Undefined means "read it off the live node", which is every other delta.
 */
export function assertEditPlanStillApplies(
  plan: EditPlan, subject: string, deltas?: BatchLayoutDeltas, becomesRowColumn?: boolean,
): void {
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
  if (plan.patch.layout) assertLayoutDeltaResolvable(node, plan.patch.layout, subject, deltas, becomesRowColumn);
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
    applyAnnotations(node, patch.annotations);
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
