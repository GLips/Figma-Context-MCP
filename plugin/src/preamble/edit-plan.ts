/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { acceptAuthoringProps } from "./authoring-input.js";
import { sceneFigma as figma } from "./scene-access.js";
import { FlcmError, type FlcmLocation } from "./flcm-error.js";
// edit-plan — the STAGES of the mutate pipeline, with no verb attached. One driver lands them in
// order (edit-apply.ts) for `flcm.edit`, `flcm.editMany` and a live node a tree places; an
// INSTANCE's override deltas (instance.ts), edits of one sublayer each, run them directly.
//
// The stages live here rather than beside the verb because instance.ts needs them and edit.ts needs
// instance.ts (an instance delta's component words resolve there) — a cycle if the verb and the
// stages shared a module. So: instance.ts → edit-plan.ts, edit.ts → { edit-plan.ts, instance.ts }.
//
// What the stages do: apply a partial delta to an existing live node (the read-side sibling is
// read.ts, the way render's live work lives in bridge.ts). ORCHESTRATION ONLY: validate → resolve →
// gate → apply. The delta compiles through the same leaf parsers create uses
// (flcm.compileNodeLocalProps → css.ts) — never the compilers, whose job is to inject creation
// defaults (FRAME({ fill }) emits layout.mode "none"; riding it would turn a recolor into an
// auto-layout kill) — and every write lands through the bridge's exported appliers, never a second
// application path. The undo scaffold (entry seal / success commit / commit-then-undo rollback) is
// the lock's, not ours: see enterMutatingVerb in mutation-lock.ts.
//
// NOT exactly-once: the lock is run-scoped, and the server can re-send a run whose reply was lost
// after a first attempt — a resend is a new run that re-applies the delta. The delta
// vocabulary is ABSOLUTE values (a fill, an opacity — never "+10"), so a duplicate apply converges
// to the same canvas; the residue is a duplicate undo step, not divergent state. Keep it that way:
// a relative delta word would turn that accepted race into canvas corruption.
//
// Validation is SEAL-time-fresh, by phase rather than by re-check (mutation-lock.ts): the compile
// reads the live node, and the compile that lands runs in the verb's synchronous GATE, right
// before the entry seal, with no await between its reads and the writes. The same compile also
// runs earlier, in prepare, purely to learn what to load — a text delta's fonts follow the node's
// live font — and the gate proves that load still covers what it compiled against the fresh node
// (fonts.ts assertTextEditFontsLoaded). A prepare or gate reject leaves zero undo residue; only the
// sealed apply span can mint a step. The lock serializes whole verbs, so a run racing its own edits
// still has each edit's gate read the canvas exactly as that edit will find it.
//
// The pipeline is NAMED STAGES because `editMany` drives the same ones N times over one queue slot
// (invariant 4: a batch verb takes the lock once and rides the internal appliers, never the public
// verb). Their ORDER is the contract, not their bodies:
//
//   1. rejectNonDeltaWords    pure — no document read at all, so it can run for every entry first
//   2. compileEditPlan        the compile, which reads the LIVE node (font identity, wrap mode).
//                             Prepare runs it for the resource hint; the gate runs it for real.
//   3. loadEditResources      the verb's ONLY awaits, for every authored word: one font load, one
//                             image request, and the annotation categories the batch names
//                             (verb-resources.ts, which also loads the live trees slot content names)
//   4. gateEditPlan           SYNC, before the seal: the node still exists, the compile again on the
//                             node as it stands now, proof the fonts loaded cover it, the
//                             live-parent layout gate and the instance write policy — every
//                             document-reading decision, made once, minted as an AuthorizedEditPlan
//   5. applyEditPlanPhase     the sealed, commit-free span, one phase at a time: appearance, text,
//                             container, placement, own size, cover, constraints, then what still
//                             PRODUCES geometry (percent size, aspect ratio, clamp), then what
//                             CONSUMES it (percent position, pivot)
//
// Every phase is a write point (write-point.ts): the words it serves are observed as the canvas
// stands then, after every earlier write in the call, and a word the canvas already holds isn't
// written. A pasted read therefore writes nothing, and the finalizer still checks each word. The
// phases are separate so the call's schedule (edit-apply.ts) can order them across every entry and
// layer: a size read while another write it depends on is still to land is a number about to move.
//
// An INSTANCE delta adds no phase here. Its three component words are split off by stage 2 and left
// RAW on the plan (`instanceWords`); the verb resolves their targets in prepare and plans them in
// its gate through instance.ts, and the schedule lands the result around these phases — the
// retarget before them, each override path's own phases after the retarget (see edit-apply.ts).
// They stay apart because a swap or a variant change replaces the very sublayers the paths name.
//
// A COMPONENT delta is split the same way (`componentWords` → component-edit.ts): the DEFINITION
// words (`description`, `propertyDefinitions`) land before the appearance, so a rename and a
// recolor of the same component are one undo step, and a sublayer's BINDING
// (`componentPropertyReferences`) lands after the constraints — the layer is what this delta makes
// it before it is wired to a property.

import {
  WriteNode, WriteProps, WriteLayout, WriteTextStyle, InstanceEditWords, ComponentEditWords,
  ComponentPropertyBindingEdit, namesFontIdentity,
} from "./ir.js";
import { applyAnnotations } from "./annotation-categories.js";
import { beginMutatingApply } from "./verb-error.js";
import { assertNodeStillOnCanvas } from "./freshness.js";
import { assertLineFillUnrotated } from "./layout-legality.js";
import { settleAspectRatio } from "./aspect-ratio.js";
import { holdPivot, settlePivot, type ApplySpan } from "./apply-span.js";
import {
  applyPaint, applySceneProps, applyAuthorizedRotation, applyLiveContainer, applyLivePlacement, applyLiveOwnSizing, applyLiveCover,
  applyLiveConstraints, trackLiveSizing, settleLiveNodePercentSize, settleLiveNodePercentPosition, resolveLiveLayoutDelta, applyTextProps,
  applyTextClamp, ApplyResources, BatchLayoutDeltas, InstancePlan, BecomesContainer,
} from "./bridge.js";
import { instanceContextOf, type InstanceContextFacts } from "./identity.js";
import {
  mintAuthorizedEditPlan, mintAuthorizedWriteSubset, preflightInstanceWrites,
  type AuthorizedEditPlan, type AuthorizedLiveLayout, type InstanceWriteClassification,
} from "./instance-write-authorization.js";
import { realizeAtWritePoint, type WrittenTogether } from "./write-point.js";
import type { PatchFieldKey } from "./obligation.js";
import type { EditOperationPhase } from "./operation-schedule.js";
import { toFigmaEffects } from "./effects.js";
import { own, rejectNonDeltaWords as rejectNonDeltaWordsAgainst, assertDeltaNotEmpty } from "./validate.js";
import { liveFontWords, assertTextEditFontsLoaded, assertTextFontsAvailable, EditFontNeed, FontMap } from "./fonts.js";
import type { ResolvedTokens } from "./tokens.js";
import { compileNodeLocalProps, compileNodeLayout } from "./compile-nodes.js";
import { compileTextStyleWords, compileTextContent, assertRunColorsBesideFillStyle, assertLineClampCount } from "./compile-text.js";
import {
  compileComponentPropertyBag, compileOverrideBag, compilePropertyDefinitionEditBag, DOCUMENT_RESOLVED_EDIT_WORDS,
} from "./compile-component-words.js";
import { compileSwapTarget } from "./target.js";
import type { EditDelta } from "./schema.js";
import { wordPathsOf } from "./authored-words.js";
import { EDIT_WORDS, WORD_GROUPS, editWordsOf } from "./vocabulary.js";

const EDIT_KEYS: ReadonlySet<string> = EDIT_WORDS;

// A node type with no row of its own (GROUP, SECTION, …) takes the shared words minus `key`. A
// conservative floor, not a mixin-derived ceiling: effects/rotation on a GROUP would land but wait for
// a deliberate widening.
const SHARED_DELTA_KEYS: ReadonlySet<string> = new Set(WORD_GROUPS.shared.filter((word) => EDIT_KEYS.has(word)));
// A SLICE is the one SceneNode with no MinimalBlendMixin — opacity/mixBlendMode don't exist on it,
// so accepting them would commit an undo step that changed nothing (the silent no-op the surface
// rejects everywhere else). The appliers' `in node` guards are belt for the same fact.
const SLICE_DELTA_KEYS: ReadonlySet<string> = new Set(["name", "visible", "locked"]);

// Stage 1 — the document-blind gate (validate.ts owns it: an instance's `overrides` entries are
// deltas judged by the same rule at construction), bound to the edit vocabulary.
export function rejectNonDeltaWords(changes: EditDelta, subject: string): void {
  rejectNonDeltaWordsAgainst(changes, EDIT_KEYS, subject);
}

// The per-type legality gate (a node's type is identity, not a live fact, so this holds whenever it
// runs; an illegal word rejects with zero writes). Returns the type's word set so the compile step
// can flag radius/clip from it.
function assertDeltaLegalForType(node: SceneNode, changes: EditDelta, subject: string): ReadonlySet<string> {
  // edit accepts on a node exactly its type's create row minus the create-only words (vocabulary.ts)
  // — one vocabulary, no permissive edit dialect: `fill` on a LINE rejects here as LINE rejects it.
  const legal = editWordsOf(node.type) ?? (node.type === "SLICE" ? SLICE_DELTA_KEYS : SHARED_DELTA_KEYS);
  for (const prop of Object.keys(changes)) {
    if (!legal.has(prop)) {
      throw new FlcmError(
        "authoring",
        "a " + node.type + " has no `" + prop + "` to edit. Drop it; a " + node.type + " edit takes only " + [...legal].join(", ") + ".",
        { path: subject + "." + prop, node: { type: node.type, name: node.name, id: node.id } },
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
      throw new FlcmError(
        "authoring",
        "this text mixes fonts, so a partial font change has no single base to resolve against — name textStyle.fontFamily in the same edit (an unnamed weight resets to regular), or restyle spans via `text` runs.",
        { path: subject + ".textStyle", node: { type: node.type, name: node.name, id: node.id } },
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
// form those parsers don't fully close: a raw WriteEffect[] passes normalizeEffects untouched, and an
// unknown kind would otherwise surface mid-apply as a fake "Figma refused". toFigmaEffects is pure
// (figma-free), so running it here keeps every vocabulary failure ahead of the first canvas write.
// Takes the LIVE node (not just its type): text words compile against live facts — font identity
// enrichment, the runs' base style, and lineClamp's bounded-width gate all read it.
function compileDeltaPatch(changes: EditDelta, legal: ReadonlySet<string>, node: SceneNode, subject: string): WriteProps {
  const patch: WriteProps = {};
  compileNodeLocalProps(patch, changes, { type: node.type, at: subject, radius: legal.has("borderRadius"), clip: legal.has("clip") });
  if (patch.effects) toFigmaEffects(patch.effects);
  // Layout words compile through the same helpers every compiler rides — never buildLayout,
  // whose creation default (omitted mode → "none") would turn a gap nudge into an auto-layout kill.
  // A LINE's `width` is LINE's own fixed-only compile, not the sizing-intent one.
  const layout = compileNodeLayout(changes, node.type, subject);
  if (layout) patch.layout = layout;
  if (node.type === "TEXT") compileTextDeltaWords(changes, patch, node as TextNode, subject);
  return patch;
}

// Split an INSTANCE delta's three component words off the delta: they are LIVE-DOCUMENT questions
// (which component a target names, which definition owns a property, which sublayer a path reaches),
// so the sync compile can only judge their SHAPE — the same shape gates INSTANCE runs, called
// here so the create and edit surfaces can't drift on what a property value or an override delta is.
// Returns undefined when the delta names none, so a plain recolor stays exactly what it was.
// (The per-type gate already rejected these words on every non-INSTANCE target.)
//
// A bag's CONTENT decides, not its presence: `componentProperties: {}` resolves to zero writes, so
// counting it as named would carry the delta past the compiled-to-nothing guard below and mint an
// undo step for nothing. The bags still compile — an empty one is legal shape, a non-object isn't.
function takeInstanceEditWords(changes: EditDelta, subject: string): InstanceEditWords | undefined {
  const words: InstanceEditWords = {};
  if (changes.exposed !== undefined) {
    if (typeof changes.exposed !== "boolean") throw new FlcmError("authoring", "must be a boolean (true or false) — got " + JSON.stringify(changes.exposed) + ".", { path: subject + ".exposed" });
    words.exposed = changes.exposed;
  }
  let named = changes.exposed !== undefined;
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
      throw new FlcmError(
        "authoring",
        "must be a string — what Figma shows beside the component in the assets panel. Got " + JSON.stringify(description) + ".",
        { path: subject + ".description" },
      );
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
    // The bag's fields are judged against the LIVE node's type in the verb's gate (component-edit.ts),
    // which is also where a name is resolved — here it is only "an object with something in it".
    if (typeof bindings !== "object" || Array.isArray(bindings)) {
      throw new FlcmError(
        "authoring",
        'must be an object naming which component property drives which field, e.g. { text: "Label" } (or null to unbind) — got ' + JSON.stringify(bindings) + ".",
        { path: subject + ".componentPropertyReferences" },
      );
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
          throw new FlcmError(
            "authoring",
            'needs a bounded width to truncate against, and this text hugs its width. Set width (a number, "fill", or "N%") in the same edit.',
            { path: subject + ".textStyle.lineClamp", node: { type: node.type, name: node.name, id: node.id } },
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
    throw new FlcmError(
      "authoring",
      '"hug" would unbound a clamped text — its lineClamp (' + node.maxLines +
        ') would never truncate again. Clear it in the same edit (textStyle: { lineClamp: "none" }) or keep a bounded width.',
      { path: subject + ".width", node: { type: node.type, name: node.name, id: node.id } },
    );
  }
  // `boldWeight` is a content convention (what `**` in `text` resolves to), not a property of the
  // live node — alone it would re-emphasize nothing, the silent no-op the surface rejects everywhere.
  if (changes.boldWeight != null && changes.text == null) {
    throw new FlcmError(
      "authoring",
      "says what `**` in `text` resolves to, and this delta names no `text`, so nothing would be re-emphasized. Pass the content back as `text` with the new `boldWeight`, or drop it.",
      { path: subject + ".boldWeight" },
    );
  }
  if (changes.text != null) {
    // A delta setting the text style hands its runs that style, so compileRun can refuse covered words.
    const base = patch.textStyle?.style || namesFontIdentity(patch.textStyle) ? patch.textStyle! : liveBaseStyle(node);
    const compiled = compileTextContent(changes.text, base, subject, changes.boldWeight ?? undefined);
    // A styled run that changes font identity with no family anywhere (no run family, no delta
    // textStyle, mixed live base) would silently land in the DEFAULT family — reject instead.
    if (compiled.runs && compiled.runs.some((r) => namesFontIdentity(r.style) && r.style.fontFamily === undefined)) {
      throw new FlcmError(
        "authoring",
        "this text mixes fonts, so a styled run has no base family to resolve against — name textStyle.fontFamily in the same edit, or give each styled run its own fontFamily.",
        { path: subject + ".text", node: { type: node.type, name: node.name, id: node.id } },
      );
    }
    Object.assign(patch, compiled);
  }
  assertRunColorsBesideFillStyle(patch, subject);
}

// ---- The pipeline. `edit` drives it once; `editMany` drives each gate stage across the whole
// batch (edit-many.ts), which is what keeps every entry's gates reading the canvas at the same
// moment, and the call's schedule orders the phases. Everything below is preamble-internal — the IIFE bundle exports only the public verbs. ----

/**
 * One entry's compiled, ready-to-apply delta.
 *
 * `instanceWords` is the INSTANCE half, still RAW: the compile is sync and document-local, and the
 * words name targets that have to be resolved async. The verb resolves those in prepare and plans
 * the half in its gate (instance.ts), and the schedule lands the result around the node-local
 * phases — the retarget before them, the overrides after the retarget.
 */
export interface EditPlan {
  node: SceneNode;
  patch: WriteProps;
  instanceWords?: InstanceEditWords;
  /** The COMPONENT half, still RAW — planned by component-edit.ts in the verb's gate. */
  componentWords?: ComponentEditWords;
  /** The delta as the agent wrote it, before the prelude: what the plan compiled from. */
  delta: EditDelta;
  /** Every word path `delta` states (authored-words.ts): where each obligation the plan owes was authored. */
  authored: ReadonlySet<string>;
}

/** A plan with no words: a sublayer an override only fills. */
export function emptyEditPlan(node: SceneNode): EditPlan {
  return { node, patch: {}, delta: {}, authored: new Set() };
}

/**
 * Stage 2 — compile against the live node. Sync, and the reads it makes (a text's font, wrap, live
 * clamp) are decisions, so the compile that LANDS is the gate's (gateEditPlan); prepare's call is
 * the resource hint. A refusal here is the same refusal either way — from prepare it just arrives
 * before the round trip, against the document as it stood then.
 */
export function compileEditPlan(node: SceneNode, delta: EditDelta, subject: string): EditPlan {
  const changes = acceptAuthoringProps<EditDelta>(delta, { type: node.type, verb: "edit", known: EDIT_KEYS, path: subject }) as EditDelta;
  // A delta of ONLY read-only words (`{ type }`) folds to nothing — same refusal as an empty object,
  // now that the prelude has run.
  assertDeltaNotEmpty(changes, EDIT_KEYS, subject);
  const legal = assertDeltaLegalForType(node, changes, subject);
  const instanceWords = takeInstanceEditWords(changes, subject);
  const componentWords = takeComponentEditWords(changes, subject);
  // Unconditional: an EMPTY component bag doesn't make `instanceWords`/`componentWords`, and it must
  // not reach the node-local compile either — `componentProperties` is not a word compileDeltaPatch knows.
  const nodeLocal = withoutDocumentResolvedWords(changes);
  const patch = Object.keys(nodeLocal).length ? compileDeltaPatch(nodeLocal, legal, node, subject) : {};
  // Every named word compiled to nothing (all values null/undefined, or an empty component bag) —
  // same hazard as `{}`: the verb would mint an undo step for zero writes. Instance and component
  // words that carry content have real work ahead of them either way, so they short-circuit it.
  if (!instanceWords && !componentWords && Object.keys(patch).length === 0) {
    throw new FlcmError("authoring", "this delta changes nothing — every value was null, undefined, or an empty object. Pass a real value, or drop the delta.", { path: subject });
  }
  const plan: EditPlan = { node, patch, delta, authored: wordPathsOf(delta) };
  if (instanceWords) plan.instanceWords = instanceWords;
  if (componentWords) plan.componentWords = componentWords;
  return plan;
}

/**
 * What the INSTANCE nodes a verb will build need: their plans (instance.ts made them against the
 * live component), the font needs of their override deltas, and the SLOT CONTENT trees those
 * overrides fill — compiled trees in their own right, whose fonts and images load exactly as a
 * rendered tree's do and whose own nested instances are already in `plans`. Produced by
 * instance.ts for a rendered tree and for an instance delta alike, twice per verb: prepare spends
 * the needs on its loads (stage 3), the gate spends the plans on the build walk.
 */
export interface InstanceNeeds {
  plans: Map<WriteNode, InstancePlan>;
  fontNeeds: EditFontNeed[];
  slotContentTrees: WriteNode[];
}

/** What prepare loaded that a gate judges a plan against: the fonts its text words need, and the tokens its bound words name. */
export interface GateResources { fonts: FontMap; tokens: ResolvedTokens }

/** Where a plan's layout words land, when that is not simply the live canvas around its node. */
export interface EditPlanLanding {
  /**
   * Every layout delta the SAME verb is applying, by node id — a batch judges its entries against
   * the canvas it is creating, not the one it found.
   */
  deltas?: BatchLayoutDeltas;
  /**
   * The node's own container after an INSTANCE delta swaps or re-variants it: its `layout` words are
   * legal or not by the incoming component's mode, never the outgoing one's (instance.ts computes it).
   */
  becomes?: BecomesContainer;
}

/**
 * Stage 4 — the delta's every document-reading decision, made in the verb's synchronous gate
 * (mutation-lock.ts) against the node as it stands at the seal: existence (the one live fact every
 * delta depends on, including the ones that read nothing else off the node), the compile itself
 * (font identity, wrap mode, the live clamp), proof that the fonts prepare loaded cover what that
 * compile produced, the layout words that only mean something against the live tree (a page
 * parent, hug legality, the hug-cycle percent), and the instance write policy. Zero writes on
 * refusal. Authorization mints the plan the stages consume (AuthorizedEditPlan): stage 5 takes
 * nothing else, so no route writes unjudged words.
 */
export function gateEditPlan(node: SceneNode, changes: EditDelta, gate: GateResources, subject: string, landing: EditPlanLanding = {}): AuthorizedEditPlan {
  assertNodeStillOnCanvas(node, subject);
  return authorizeEditPlan(compileEditPlan(node, changes, subject), gate, subject, landing);
}

/**
 * The second half of stage 4 on its own, for a verb that has to plan a delta's INSTANCE half
 * between the compile and these gates (the root's layout gate reads the container the retarget
 * leaves behind — `landing.becomes` comes from that plan), or that applies a plan it compiled on
 * another node (a clone's copy).
 */
export function authorizeEditPlan(plan: EditPlan, gate: GateResources, subject: string, landing: EditPlanLanding = {}): AuthorizedEditPlan {
  assertEditPlanWordsLand(plan, gate.fonts, subject);
  const resolved = plan.patch.layout ? resolveLiveLayoutDelta(plan.node, plan.patch.layout, subject, landing.deltas, landing.becomes) : null;
  return mintAuthorizedEditPlan(subject, plan, resolved, instanceContextOf(plan.node), landing);
}

/**
 * Stage 4 for a plan whose writes land on a node that doesn't exist yet, or not where it sits yet —
 * a definition's override before its instance is stamped, a clone's props before the copy: the same
 * refusals, judged in `context`, with nothing minted. Its layout words resolve against the plan
 * node's own parent. The plan is authorized again on the live node it writes. Without `gate` (a
 * prepare-time compile) the font proof waits for that. Returns what the policy made of the plan,
 * for the gate's realize-only check (call-obligations.ts).
 */
export function preflightEditPlan(plan: EditPlan, gate: GateResources | undefined, subject: string, context: InstanceContextFacts): InstanceWriteClassification {
  if (gate) assertEditPlanWordsLand(plan, gate.fonts, subject);
  const resolved = plan.patch.layout ? resolveLiveLayoutDelta(plan.node, plan.patch.layout, subject) : null;
  return preflightInstanceWrites(subject, plan, resolved, context);
}

function assertEditPlanWordsLand(plan: EditPlan, fonts: FontMap, subject: string): void {
  assertTextEditFontsLoaded(plan.node, plan.patch, fonts, subject);
  // Outside the layout gate on purpose: this rule reads ONE layout word beside one appearance word,
  // and either half can arrive alone (rotating a line that already fills, or filling one that is
  // already rotated), so the effective pair is read off the live node wherever the delta is silent.
  const live = plan.node as SceneNode & { layoutSizingHorizontal?: string; rotation?: number };
  assertLineFillUnrotated(
    plan.node.type,
    (plan.patch.layout?.sizing?.horizontal ?? (live.layoutSizingHorizontal === "FILL" ? "fill" : undefined)) === "fill",
    plan.patch.rotation ?? live.rotation,
    subject,
  );
}

/**
 * The failure builder for one entry's apply, obtained ONCE for all its stages. The identity is
 * snapshotted here (see beginMutatingApply) and the appearance stage may rename the node, so
 * re-opening the span per stage would report a name the rollback is about to erase.
 */
export type EditPlanFailure = (cause: unknown) => Error;

export function openEditPlanApply(plan: AuthorizedEditPlan, span: ApplySpan, at: FlcmLocation = {}): EditPlanFailure {
  const fail = beginMutatingApply(plan.node, at);
  // Here rather than at the first write: an instance retarget runs between the two and can resize the node.
  if (pivots(plan)) holdPivot(span, plan.node);
  return fail;
}

// A layer an instance locks has no transform of its own to re-centre: Figma throws on its x/y.
function pivots(plan: AuthorizedEditPlan): boolean {
  return !plan.context.ownWritesLockedBy;
}

// ---- Write points. Each phase below is one or more of them: the fields it would write, observed
// now (write-point.ts), and only the ones an unrealized word still needs, re-authorized against the
// node as it stands (mintAuthorizedWriteSubset) before the applier sees them. ----

const APPEARANCE_PROPS: readonly (keyof WriteProps)[] = [
  "annotations", "name", "visible", "locked", "blendMode", "opacity", "fills", "strokes", "strokeWeight", "strokeAlign",
  "borderRadius", "effects", "styles", "clip", "rotation",
];
// A run-styled text's base paint is part of the text write: runs land over it, never under.
const TEXT_PAINT_PROPS: readonly (keyof WriteProps)[] = ["fills", "styles"];
const TEXT_PROPS: readonly (keyof WriteProps)[] = ["textStyle", "text", "runs"];
const CONTAINER_LAYOUT: readonly (keyof WriteLayout)[] = ["mode", "wrap", "gap", "padding", "justifyContent", "alignItems", "gridTemplateColumns", "gridTemplateRows"];
const PLACEMENT_LAYOUT: readonly (keyof WriteLayout)[] = ["position", "left", "top", "gridColumn", "gridRow", "justifySelf", "alignSelf"];
const AXIS_FIELDS: readonly PatchFieldKey[] = ["axis:horizontal", "axis:vertical"];
const AXIS_PARTS = { horizontal: "width", vertical: "height" } as const;
const SIZE_BAGS = ["dimensions", "percentSize", "designedSize"] as const;

/**
 * `layout` without its container words: what a placed node re-applies where it lands. Its own
 * container is the edit phases' to write, at their own write point.
 */
export function withoutContainerWords(layout: WriteLayout): WriteLayout {
  const out: WriteLayout = { ...layout };
  for (const key of CONTAINER_LAYOUT) delete out[key];
  return out;
}

const props = (keys: readonly (keyof WriteProps)[]): PatchFieldKey[] => keys.map((key) => `prop:${key}` as const);
const layoutKeys = (keys: readonly (keyof WriteLayout)[]): PatchFieldKey[] => keys.map((key) => `layout:${key}` as const);

// The fields a plan writes at all: the compiled words, as authored (a stretch alias is still
// `alignSelf` here, resolving to an axis only with the subset), minus the realize-only ones.
function writableFieldsOf(plan: AuthorizedEditPlan): Set<PatchFieldKey> {
  const out = new Set<PatchFieldKey>();
  const source = plan.source.patch;
  for (const key of Object.keys(source) as (keyof WriteProps)[]) if (key !== "layout" && source[key] !== undefined) out.add(`prop:${key}`);
  const wl = source.layout ?? {};
  for (const key of Object.keys(wl) as (keyof WriteLayout)[]) {
    if (wl[key] === undefined) continue;
    if (key === "sizing") for (const axis of Object.keys(wl.sizing!) as ("horizontal" | "vertical")[]) { if (wl.sizing![axis] !== undefined) out.add(`axis:${axis}`); }
    else if ((SIZE_BAGS as readonly string[]).includes(key)) for (const axis of ["horizontal", "vertical"] as const) { if ((wl[key] as Record<string, unknown>)[AXIS_PARTS[axis]] !== undefined) out.add(`axis:${axis}`); }
    else out.add(`layout:${key}`);
  }
  for (const key of plan.realizeOnly.keys()) out.delete(key);
  return out;
}

// The compiled plan's words at `fields`: the props, and the layout words with each axis's parts.
function patchAt(source: WriteProps, fields: ReadonlySet<PatchFieldKey>): WriteProps {
  const out: WriteProps = {};
  for (const key of Object.keys(source) as (keyof WriteProps)[]) {
    if (key !== "layout" && fields.has(`prop:${key}`)) (out as Record<string, unknown>)[key] = source[key];
  }
  const wl = source.layout;
  if (!wl) return out;
  const layout: WriteLayout = {};
  for (const key of Object.keys(wl) as (keyof WriteLayout)[]) {
    if (key === "sizing" || (SIZE_BAGS as readonly string[]).includes(key)) continue;
    if (fields.has(`layout:${key}`)) (layout as Record<string, unknown>)[key] = wl[key];
  }
  for (const axis of ["horizontal", "vertical"] as const) {
    if (!fields.has(`axis:${axis}`)) continue;
    if (wl.sizing?.[axis] !== undefined) layout.sizing = { ...layout.sizing, [axis]: wl.sizing[axis] };
    for (const bag of SIZE_BAGS) {
      const part = (wl[bag] as Record<string, unknown> | undefined)?.[AXIS_PARTS[axis]];
      if (part !== undefined) (layout as Record<string, unknown>)[bag] = { ...(layout[bag] as object | undefined), [AXIS_PARTS[axis]]: part };
    }
  }
  if (Object.keys(layout).length) out.layout = layout;
  return out;
}

interface WritePointOptions {
  together?: readonly WrittenTogether[];
  /** Fields the applier reads beside the ones it writes (applyChildPosition needs the position). */
  context?: readonly PatchFieldKey[];
  /** Fields written whenever present, held or not: a zIndex, which the sibling order settles across the whole parent. */
  always?: readonly PatchFieldKey[];
}

/**
 * One write point of `plan`: null when none of `fields` is due now, else the due ones re-authorized
 * on the node as it stands, and the call that records them as written once the applier ran.
 */
function writePoint(plan: AuthorizedEditPlan, fields: readonly PatchFieldKey[], options: WritePointOptions = {}): { plan: AuthorizedEditPlan; landed(): void } | null {
  const writable = writableFieldsOf(plan);
  const present = fields.filter((field) => writable.has(field));
  const always = (options.always ?? []).filter((field) => writable.has(field));
  if (!present.length && !always.length) return null;
  const decision = realizeAtWritePoint(plan.node, present, options.together);
  if (!decision.writes.size && !always.length) return null;
  const at = new Set([...decision.writes, ...always]);
  for (const field of options.context ?? []) if (writable.has(field)) at.add(field);
  const patch = patchAt(plan.source.patch, at);
  const resolved = patch.layout ? resolveLiveLayoutDelta(plan.node, patch.layout, plan.subject, plan.landing.deltas, plan.landing.becomes) : null;
  return { plan: mintAuthorizedWriteSubset(plan, patch, resolved), landed: decision.landed };
}

function runsOnText(plan: AuthorizedEditPlan): boolean {
  return plan.node.type === "TEXT" && !!plan.source.patch.runs;
}

/** Snapshot the sizes `plan`'s layout tree measures, before the call's first write lands (sizing-diagnostics). */
export function trackEditPlanSizing(plan: AuthorizedEditPlan): void {
  if (plan.layout) trackLiveSizing(plan.layout);
}

// The phases an edit plan's own writes land in, in order on its node (operation-schedule.ts).
export const EDIT_PLAN_PHASES = [
  "appearance", "text", "container", "placement", "own-size", "cover", "constraints", "percent-size", "aspect-ratio", "text-clamp", "percent-position",
] as const satisfies readonly EditOperationPhase[];
export type EditPlanPhase = (typeof EDIT_PLAN_PHASES)[number];

/**
 * One phase of `plan`'s writes, as a write point: what the phase would write, observed now, and only
 * what an unrealized word still needs is written. Sealed and commit-free; no awaits, by the lock's
 * contract. A throw is reported through `fail`, which names the node as it stood before the call.
 */
export function applyEditPlanPhase(fail: EditPlanFailure, plan: AuthorizedEditPlan, phase: EditPlanPhase, resources: ApplyResources): void {
  try {
    EDIT_PLAN_PHASE_APPLIERS[phase](plan, resources);
  } catch (cause) {
    throw fail(cause);
  }
}

const EDIT_PLAN_PHASE_APPLIERS: { readonly [P in EditPlanPhase]: (plan: AuthorizedEditPlan, resources: ApplyResources) => void } = {
  // Paint, effects, the scene props, rotation, annotations.
  appearance(plan, resources) {
    const { node } = plan;
    // First, while the transform is still the one the node arrived with (a no-op once open).
    if (pivots(plan)) holdPivot(resources.span, node);
    // An instance's overrides land after its own words and can resize it, so its pivot waits for
    // the span's settle, which runs after them.
    if (plan.instanceWords && pivots(plan)) resources.span.pivots.push({ node, layout: plan.layout?.child.layout });
    const fields = runsOnText(plan) ? APPEARANCE_PROPS.filter((key) => !TEXT_PAINT_PROPS.includes(key)) : APPEARANCE_PROPS;
    const at = writePoint(plan, props(fields));
    if (!at) return;
    applyPaint(node, at.plan.patch, resources);
    applySceneProps(node, at.plan.patch);
    applyAuthorizedRotation(node, at.plan);
    applyAnnotations(node, at.plan.patch.annotations);
    at.landed();
  },
  // Before layout, create's own order (buildText: characters, then applyOwnSizing), so the layout
  // words size the reflowed text rather than the text it replaces. Runs over a base style are one
  // write: a base word written without its runs would flatten them.
  text(plan, resources) {
    if (plan.node.type !== "TEXT") return;
    const node = plan.node as TextNode;
    const composite = runsOnText(plan);
    const fields = props(composite ? [...TEXT_PAINT_PROPS, ...TEXT_PROPS] : TEXT_PROPS);
    const at = writePoint(plan, fields, { together: composite ? [{ when: fields, write: fields }] : [] });
    if (!at) return;
    assertTextFontsAvailable(node, at.plan.patch, plan.subject);
    // The base paint before the runs, which land over it.
    if (composite) applyPaint(node, at.plan.patch, resources);
    applyTextProps(node, at.plan.patch, resources);
    at.landed();
  },
  container(plan, resources) {
    const container = layoutKeys(CONTAINER_LAYOUT);
    // A new mode re-reads every container word, so they land with it.
    // The axes ride along unwritten: a grid's fractional tracks are legal only beside a bounded width.
    landLayout(plan, container, (layout) => applyLiveContainer(layout, resources), { together: [{ when: ["layout:mode"], write: container }], context: AXIS_FIELDS });
  },
  placement(plan, resources) {
    landLayout(plan, [...layoutKeys(PLACEMENT_LAYOUT), ...AXIS_FIELDS], (layout) => applyLivePlacement(layout, resources), { context: ["layout:position"], always: ["layout:zIndex"] });
  },
  "own-size"(plan, resources) {
    landLayout(plan, ["layout:bounds", ...AXIS_FIELDS], (layout) => applyLiveOwnSizing(layout, resources));
  },
  cover(plan) {
    landLayout(plan, AXIS_FIELDS, applyLiveCover);
  },
  constraints(plan) {
    landLayout(plan, ["layout:constraints"], applyLiveConstraints);
  },
  // What still PRODUCES geometry after the writes: the percent size, then the aspectRatio it may
  // drive, then the clamp that clips against the wrap those sizes produced.
  "percent-size"(plan) {
    landLayout(plan, AXIS_FIELDS, settleLiveNodePercentSize);
  },
  "aspect-ratio"(plan) {
    // The axes ride along unwritten: which one drives the ratio is a fact of how each is sized.
    landLayout(plan, ["layout:aspectRatio"], (layout) => settleAspectRatio(plan.node, layout), { context: AXIS_FIELDS });
  },
  "text-clamp"(plan) {
    if (plan.node.type !== "TEXT") return;
    const at = writePoint(plan, ["prop:maxLines"]);
    if (!at) return;
    applyTextClamp(plan.node as TextNode, at.plan.patch.maxLines);
    at.landed();
  },
  // What CONSUMES geometry: percent position, which reads the parent's realized size, then the
  // centre pivot, which reads the final box.
  "percent-position"(plan, resources) {
    landLayout(plan, ["layout:percentPos"], settleLiveNodePercentPosition, { context: ["layout:position"] });
    if (!plan.instanceWords && pivots(plan)) settlePivot(resources.span, plan.node, plan.layout?.child.layout);
  },
};

function landLayout(plan: AuthorizedEditPlan, fields: readonly PatchFieldKey[], apply: (layout: AuthorizedLiveLayout) => void, options?: WritePointOptions): void {
  if (!plan.layout) return;
  const at = writePoint(plan, fields, options);
  if (!at?.plan.layout) return;
  apply(at.plan.layout);
  at.landed();
}
