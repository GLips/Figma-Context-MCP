/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { assertExposureTree, assertExposureTarget } from "./instance-exposure.js";
import { assertBounds } from "./size-bounds.js";
import { componentPath, definitionId, liveSublayerId } from "@framelink/core";
// instance — the component half of the write path, for BOTH verbs that touch one:
//
//   • CREATE (INSTANCE): everything an INSTANCE carries raw (ir.ts WriteProps on why)
//     resolved against the live document in render's synchronous gate, right before its entry
//     seal, so that the build walk (bridge.buildInstance) is a sync sequence of writes with
//     nothing left to look up.
//   • EDIT (flcm.edit / editMany on an INSTANCE target): the same three words as a delta —
//     `componentProperties`, `overrides`, and `componentId`, which under edit SWAPS the component.
//     Read words are write words: what `get` reports on an instance is what changes it, so there is
//     no separate variant/swap verb.
//
// Every refusal here fires with zero writes, and names the component's OWN vocabulary — its real
// property names, the variant combinations it actually has, the sublayer paths it actually holds —
// because the agent is authoring against a definition it can't see.
//
// TWO HALVES, by the lock's phase rule (mutation-lock.ts). The async half (resolveInstanceTreeTargets,
// resolveInstanceEditTargets) turns every target the words name — the component, a swap value, a
// nested instance inside slot content — into a live node ahead of the seal, and decides nothing.
// The sync half (planInstanceTree, planInstanceEdit) reads the component's definitions, picks the
// variant, compiles the overrides against their sublayers, and is what the verb's GATE runs, so
// every one of those reads is made against the document as it stands at the seal. A verb's
// prepare also runs the sync half once, as a HINT: an override's text delta decides which fonts to
// load, and a refusal there is the gate's refusal a moment early.
//
// One shared authority for the property rules, so what an instance is created with and what an
// instance edit sets can't drift: both resolve names, types and variants through the same functions.
// The one place they diverge is deliberate and named at planLiveOverrides — a create's
// override compiles against the component's DEFINITION node (the instance doesn't exist yet), while
// an edit that leaves the instance pointing where it already points compiles against the LIVE
// sublayer, which is the real target and carries the real font and wrap.
//
// A SLOT is filled from here too. Read words are write words: `get` republishes a filled slot's
// content as `children` under the slot's path in `overrides`, and stating `children` at that path
// — at create or under edit — is what fills one. The content nodes are built inside the instance's own
// sealed span through the same attach-then-size entry every insert rides (bridge.attachBuiltChild),
// so slot content lands exactly as appended content does; afterwards the structural verbs treat
// it as the ordinary tree it is (structure.ts's gate knows a SLOT's child list is open).

import { WriteNode, BuiltNode, WriteChild, ComponentPropertyInput, InstanceEditWords, OverrideDeltaInput, Target, type WriteProps } from "./ir.js";
import { ResolvedTargets } from "./target.js";
import {
  attachBuiltChild, liveParentAttachFacts, assertBuiltRootLandsUnderParent, assertBuiltInteriorLegal,
  InstancePlan, RenderCtx, BatchLayoutDeltas, BecomesContainer,
} from "./bridge.js";
import { assertLayoutRealizableForType } from "./layout-legality.js";
import { layoutModeOf } from "./layout-mode.js";
import {
  EditPlan, EditPlanFailure, InstanceNeeds, type GateResources, compileEditPlan, emptyEditPlan, gateEditPlan, authorizeEditPlan, preflightEditPlan, openEditPlanApply,
  applyEditPlanPhase, trackEditPlanSizing, EDIT_PLAN_PHASES, type EditPlanPhase,
} from "./edit-plan.js";
import {
  isComponentDefinition, variantSetOf, describeNodeIdentity, definitionOwnerOf, propertyDefinitionsOf, isSlotHole, SLOT_CONTENT_WIRE_KEY,
  instanceContextOf, projectedInstanceContextOf, type InstanceContextFacts,
} from "./identity.js";
import { assertInstanceRootLayoutMode, type AuthorizedEditPlan, type RealizeOnlyFields } from "./instance-write-authorization.js";
import { gateCallObligations, type RealizeOnlyCheck } from "./call-obligations.js";
import { geometryWritesAt, geometryWritesOf, writePointGeometryReads, type GeometryEffect } from "./geometry-dependency.js";
import {
  definitionsEditedAt, definitionsInheritedBy, scheduleEditOperations, type EditOperation, type EditOperationPhase, type InstanceMains, type OperationRef,
} from "./operation-schedule.js";
import { realizeOnlyChecksOf } from "./obligation-derivation.js";
import type { Obligation } from "./obligation.js";
import { realizeAtWritePoint } from "./write-point.js";
import { SLOT_CONTENT_WORD } from "./compile-component-words.js";
import { own } from "./validate.js";
import { bareName, matchPropertyNames } from "./component-properties.js";
import type { EditDelta } from "./schema.js";

const SUBJECT = "INSTANCE";

// A read `null` in an override delta means "the instance LACKS this field the component has" (the
// read shape omits defaults, so a paint removed or an opacity back at 1 has no value to state).
// Authoring it back needs the removal WORD for that field; these are the fields that have one.
// Everything else (`text`, `layout`, a size) has no "absent" state on a node, and a null there is
// refused rather than guessed.
const NULL_RESTORE: Record<string, unknown> = {
  fill: "none",
  stroke: "none",
  effects: "none",
  opacity: 1,
  borderRadius: 0,
  rotation: 0,
};

/**
 * One sublayer's override: the component-relative path, the sublayer's own words as a delta
 * (undefined when the override only fills a slot), the plan compiled from them against the sublayer
 * the route chose (an empty patch for a fill-only override — the existence gate still runs on it),
 * and, at a SLOT's path, the content the override states: the nodes to build there, in order.
 * `realizeOnly` is what the instance write policy made of its words in `context`, where that
 * sublayer sits: words it owes and never writes.
 *
 * `delta` rides along because the plan is compiled AGAIN inside the sealed span, against the live
 * sublayer as it stands after this call's own retarget (beginOverrideApply).
 */
export interface OverridePlan {
  path: string; delta: EditDelta | undefined; plan: EditPlan; slotContent?: WriteNode[];
  realizeOnly: RealizeOnlyFields; context: InstanceContextFacts;
}

const NO_REALIZE_ONLY: RealizeOnlyFields = new Map();

/**
 * What the sync planners resolve against: the targets prepare resolved, and — in the gate — the
 * fonts and tokens it loaded, so every override plan is proven against them. `gate` is absent for
 * the HINT call from prepare, where there is nothing loaded yet to prove anything about.
 */
export interface InstancePlanning { targets: ResolvedTargets; gate?: GateResources }

// ---- the async half: targets, resolved ahead of the seal ----

/**
 * Resolve every target the INSTANCE nodes in `tree` name — the tree's own instances, and every one
 * inside the slot content they fill, however deep (a nested instance inside a slot fills ITS slot
 * through the same path). Two rounds per node, because WHICH property values are targets is a fact
 * of the component the first round resolves: its swap-typed properties. Read here as the document
 * stands now; the gate reads the definitions again, and a value that became a swap during the
 * loads is a miss the lookup refuses (target.ts ResolvedTargets).
 */
export async function resolveInstanceTreeTargets(tree: WriteNode, targets: ResolvedTargets): Promise<void> {
  const instances: BuiltNode[] = [];
  collectInstanceNodes(tree, instances);
  for (const wn of instances) {
    await targets.resolve(wn.component as Target);
    await resolveSwapValueTargets(componentNodeOrNull(wn.component as Target, targets), wn.componentProperties || {}, targets);
  }
}

// The resolved component behind a target, or null when the resolution failed — the gate is where
// that failure is reported (targets.node throws it there); prepare only needs to know whether there
// is a definition to read swap types off.
function componentNodeOrNull(target: Target, targets: ResolvedTargets): any | null {
  try {
    return targets.node(target, SUBJECT);
  } catch {
    return null;
  }
}

// The property values a definition declares as INSTANCE_SWAP name components; resolve those. A
// name that matches nothing, or more than one definition, is the gate's refusal to make.
async function resolveSwapValueTargets(owner: any | null, authored: Record<string, ComponentPropertyInput>, targets: ResolvedTargets): Promise<void> {
  if (!owner || !isComponentDefinition(owner)) return;
  const definitions = propertyDefinitionsOf(definitionOwnerOf(owner));
  for (const name of Object.keys(authored)) {
    const matches = matchPropertyNames(name, definitions);
    if (matches.length !== 1 || definitions[matches[0]].type !== "INSTANCE_SWAP") continue;
    const value = authored[name];
    if (typeof value !== "boolean") await targets.resolve(value as Target);
  }
}

// ---- the sync half: the plans, made against the document as it stands ----

/**
 * Plan every INSTANCE node in `tree` (and in the slot content its instances fill). Returns the plans
 * (by WriteNode identity), the font needs the override deltas add, and the slot content trees —
 * prepare spends the last two on its one font load and one image request; the gate spends the
 * first on the build walk.
 */
export function planInstanceTree(tree: WriteNode, planning: InstancePlanning): InstanceNeeds {
  const needs: InstanceNeeds = { plans: new Map(), fontNeeds: [], slotContentTrees: [] };
  const instances: BuiltNode[] = [];
  collectInstanceNodes(tree, instances);
  for (const wn of instances) {
    const { plan, overrides } = (() => {
      try { return planInstanceNode(wn, planning); }
      catch (cause) { throw new Error((wn.sourcePath ?? "INSTANCE") + ": " + (cause instanceof Error ? cause.message : String(cause))); }
    })();
    needs.plans.set(wn, plan);
    for (const o of overrides) {
      needs.fontNeeds.push(o.plan);
      if (o.slotContent) needs.slotContentTrees.push(...o.slotContent);
    }
  }
  return needs;
}

// Descends into slot content as well as children: a `INSTANCE` inside an override's `children`
// is an INSTANCE node like any other, and the build walk will ask for its plan by identity.
function collectInstanceNodes(wn: WriteChild, out: BuiltNode[]): void {
  if (!wn || typeof wn !== "object") return;
  if (wn.liveId === undefined && wn.type === "INSTANCE") out.push(wn);
  for (const child of wn.children || []) collectInstanceNodes(child, out);
  for (const content of slotContentListsOf(wn)) for (const child of content) collectInstanceNodes(child, out);
}

// Every `children` array an INSTANCE node's overrides carry — the raw word, shape-checked at
// construction (flcm.compileOverrideBag) and resolved to a slot here.
function slotContentListsOf(wn: WriteNode): WriteChild[][] {
  const out: WriteChild[][] = [];
  if (wn.liveId !== undefined) return out; // a live instance's slot content is its edit delta's (planInstanceEdit)
  for (const path of Object.keys(wn.overrides || {})) {
    const content = own(wn.overrides![path], SLOT_CONTENT_WORD);
    if (Array.isArray(content)) out.push(content as WriteChild[]);
  }
  return out;
}

/**
 * The needs of slot content a DELTA states: each content tree's own instances (and their slot
 * content, recursively), gathered so the verb loads them beside the delta's own resources.
 */
function planSlotContentNeeds(content: readonly WriteNode[], planning: InstancePlanning): InstanceNeeds {
  const needs: InstanceNeeds = { plans: new Map(), fontNeeds: [], slotContentTrees: [...content] };
  for (const tree of content) {
    assertExposureTree(tree);
    const nested = planInstanceTree(tree, planning);
    nested.plans.forEach((plan, wn) => needs.plans.set(wn, plan));
    needs.fontNeeds.push(...nested.fontNeeds);
    needs.slotContentTrees.push(...nested.slotContentTrees);
  }
  return needs;
}

function planInstanceNode(wn: BuiltNode, planning: InstancePlanning): { plan: InstancePlan; overrides: OverridePlan[] } {
  const resolved = resolveComponentNode(planning.targets.node(wn.component as Target, SUBJECT), SUBJECT);
  const { component, properties } = resolveComponentProperties(resolved, wn.componentProperties || {}, SUBJECT, planning.targets);
  // The root's layout words are legal or not by the COMPONENT's mode — the same live fact edit
  // reads off its target. Judged here, not in the compiler, because that is where it's known.
  if (wn.layout) assertBounds(wn.layout.bounds, component, SUBJECT);
  if (wn.layout) assertLayoutRealizableForType("INSTANCE", wn.layout, component.layoutMode, SUBJECT, component.layoutWrap === "WRAP");
  assertInstanceRootLayoutMode(SUBJECT, null, wn.layout?.mode, layoutModeOf(component));
  const overrides = planDefinitionOverrides(component, wn.overrides || {}, SUBJECT, planning.gate);
  // The instance is sized by its own words before its overrides land, so a realize-only measure can wait on them.
  if (planning.gate) gateCallObligations({ checks: overrideRealizeOnlyChecks(overrides, planning.gate, SUBJECT), writes: geometryWritesOf(component, { layout: wn.layout }) }, SUBJECT);
  return {
    plan: {
      component,
      // A create stamps the exact variant (`component` above), so the variant axes are not restated
      // as property writes — only the non-variant values are.
      properties,
      applyOverrides: (instance, ctx) => applyOverridePlans(instance, overrides, component, ctx, "render"),
      overrides,
    },
    overrides,
  };
}

// ---- the component ----

interface ResolvedComponent {
  /** The component to stamp before any variant selection: a set's default, or the named one. */
  base: any;
  /** The set, when the base is a variant — the owner of the property definitions. */
  set: any | null;
}

// A live COMPONENT, plus the set that owns its property definitions when it is a variant.
function resolvedFromComponent(node: any): ResolvedComponent {
  return { base: node, set: variantSetOf(node) };
}

/**
 * The node a component target resolved to, read as a component. Exported because every verb that
 * takes one rides it — INSTANCE's positional component, an instance-swap property's value,
 * and flcm.component's `instance_swap` default — so they all refuse an INSTANCE (or a plain frame)
 * with one sentence. Sync, from a node prepare already resolved: a set's default variant is a live
 * fact, read where every live fact is read.
 */
function resolveComponentNode(node: any, subject: string): ResolvedComponent {
  if (node.type === "COMPONENT_SET") return { base: node.defaultVariant, set: node };
  if (node.type === "COMPONENT") return resolvedFromComponent(node);
  const who = describeNodeIdentity(node);
  if (node.type === "INSTANCE") {
    throw new Error(
      subject + ": " + who + " is itself an instance, not a component. Pass the component it comes from — flcm.get(" + JSON.stringify(node.id) + ") reports it as `componentId`.",
    );
  }
  throw new Error(subject + ": " + who + " is not a component — only a COMPONENT (or a COMPONENT_SET, whose variant the `componentProperties` pick) can be instantiated.");
}


// An authored name resolves to Figma's suffixed one: exact first, else the ONE definition whose
// bare name matches. Two definitions sharing a bare name (legal in Figma — the suffix is the
// identity) refuse rather than guess, listing both full names so the agent can pick.
//
// `where` is the WORD the name was written under (`flcm.edit.componentProperties`,
// `flcm.edit.propertyDefinitions`, a binding field) — the refusal names it so the agent can see
// which half of a multi-word delta it is being told about.
export function resolvePropertyName(authored: string, definitions: Record<string, any>, where: string): string {
  const matches = matchPropertyNames(authored, definitions);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      where + ": " + JSON.stringify(authored) + " names " + matches.length + " properties on this component (" +
        matches.map((m) => JSON.stringify(m)).join(", ") + ") — use the full name with its #suffix.",
    );
  }
  const available = Object.keys(definitions);
  throw new Error(
    where + ": this component has no property " + JSON.stringify(authored) + " — " +
      (available.length ? "its properties are " + available.map((n) => JSON.stringify(bareName(n))).join(", ") : "it defines no properties") + ".",
  );
}

/**
 * Resolve a property bag against a component's own definitions. `properties` are the NON-variant
 * writes (ready for setProperties, in Figma's suffixed names); `variant` is the authored variant
 * tuple, kept separate because the two verbs spend it differently — create stamps `component`
 * directly, while an edit with no swap writes the axes through setProperties so Figma re-points
 * the instance in place. Either way `component` is the exact variant the combination names, and
 * the whole combination is validated before either verb writes anything.
 */
function resolveComponentProperties(
  resolved: ResolvedComponent, authored: Record<string, ComponentPropertyInput>, subject: string, targets: ResolvedTargets,
): { component: any; properties: Record<string, string | boolean>; variant: Record<string, string> } {
  const definitions = propertyDefinitionsOf(definitionOwnerOf(resolved.base));
  const properties: Record<string, string | boolean> = {};
  const variant: Record<string, string> = {};
  // A slot named here is refused — but only once the variant is known, because the path the
  // refusal hands over is per variant (each realizes the set's slot with its own frame).
  let slotNamed: { full: string; where: string } | undefined;
  for (const name of Object.keys(authored)) {
    const full = resolvePropertyName(name, definitions, subject + ".componentProperties");
    const def = definitions[full];
    const value = authored[name];
    const where = subject + ".componentProperties[" + JSON.stringify(name) + "]";
    switch (def.type) {
      case "VARIANT": {
        const options: string[] = def.variantOptions || [];
        if (typeof value !== "string" || options.indexOf(value) === -1) {
          throw new Error(where + ": " + JSON.stringify(value) + " is not an option of variant axis " + JSON.stringify(full) + " — the options are " + options.map((o) => JSON.stringify(o)).join(", ") + ".");
        }
        variant[full] = value;
        break;
      }
      case "BOOLEAN":
        if (typeof value !== "boolean") throw new Error(where + ": " + JSON.stringify(full) + " is a boolean property — got " + JSON.stringify(value) + ".");
        properties[full] = value;
        break;
      case "TEXT":
        if (typeof value !== "string") throw new Error(where + ": " + JSON.stringify(full) + " is a text property — got " + JSON.stringify(value) + ".");
        properties[full] = value;
        break;
      case "INSTANCE_SWAP": {
        if (typeof value === "boolean") throw new Error(where + ": " + JSON.stringify(full) + " is an instance-swap property, which takes a component (its node id or a handle) — got " + JSON.stringify(value) + ".");
        const swap: any = targets.node(value as Target, where);
        if (swap.type !== "COMPONENT") {
          throw new Error(where + ": " + JSON.stringify(full) + " swaps in a COMPONENT, and " + JSON.stringify(swap.name) + " (id " + JSON.stringify(swap.id) + ") is a " + swap.type + (swap.type === "COMPONENT_SET" ? " — name one of its variants" : "") + ".");
        }
        properties[full] = swap.id;
        break;
      }
      case "SLOT":
        if (!slotNamed) slotNamed = { full, where };
        break;
      default:
        throw new Error(where + ": " + JSON.stringify(full) + " is a " + String(def.type) + " property, which flcm has no word for.");
    }
  }
  const component = Object.keys(variant).length ? selectVariant(resolved, variant, subject) : resolved.base;
  if (slotNamed) {
    // A slot has no value: its content is stated at the slot's PATH, and the path is the bound
    // frame's in THIS variant — walked so the refusal hands over the exact key to write.
    const hole = slotFrameBoundTo(component, slotNamed.full);
    const path = hole ? JSON.stringify(componentPath(hole.id)) : '"<slotPath>"';
    throw new Error(
      slotNamed.where + ": " + JSON.stringify(slotNamed.full) + " is a slot, and a slot has no value — its content is stated as `children` at the slot's path: " +
        subject + ".overrides[" + path + "] = { children: [ …nodes ] } (FRAME/text/instance…; [] empties it).",
    );
  }
  return { component, properties, variant };
}

// The whole variant combination is validated against the set's children — a partial that Figma
// would resolve by "keep the rest of the current variant" is completed the same way here (from
// the base's own axes), then must name EXACTLY one variant. The set's own child list is the
// authority, not the axis options: an axis may list an option no combination actually has.
function selectVariant(resolved: ResolvedComponent, variant: Record<string, string>, subject: string): any {
  const { base, set } = resolved;
  if (!set) {
    throw new Error(subject + ".componentProperties: " + JSON.stringify(base.name) + " is a standalone component with no variant axes, but a variant value was named.");
  }
  const tuple: Record<string, string> = { ...(base.variantProperties || {}), ...variant };
  const axes = Object.keys(tuple);
  const matches = (set.children as any[]).filter((v) => {
    const props = v.variantProperties || {};
    return axes.every((axis) => props[axis] === tuple[axis]) && Object.keys(props).length === axes.length;
  });
  if (matches.length === 1) return matches[0];
  const spelled = axes.map((a) => a + "=" + tuple[a]).join(", ");
  if (matches.length === 0) {
    const has = (set.children as any[]).map((v) => JSON.stringify(v.name)).join(", ");
    throw new Error(subject + ".componentProperties: " + JSON.stringify(set.name) + " has no variant " + spelled + " — its variants are " + has + ".");
  }
  throw new Error(subject + ".componentProperties: " + JSON.stringify(set.name) + " has " + matches.length + " variants named " + spelled + " (the set has a conflict Figma flags) — resolve it in the file, or pass the variant's own id as the component.");
}

// ---- the overrides ----

// The frame bound to a slot property in ONE definition, or null. The variant's own subtree, not
// the set's: each variant realizes the set's slot with its own frame.
function slotFrameBoundTo(definition: any, full: string): any | null {
  return definition.findOne((n: any) => own((n.componentPropertyReferences || {}) as Record<string, string>, SLOT_CONTENT_WIRE_KEY) === full);
}

// The slot paths a definition HAS — what a `children` at the wrong path is told instead.
function slotPathsSentence(definition: any): string {
  const paths = (definition.findAll((n: any) => isSlotHole(n)) as any[]).map((n) => JSON.stringify(componentPath(n.id)));
  if (paths.length) return "The slot" + (paths.length > 1 ? "s" : "") + " of " + describeNodeIdentity(definition) + " " + (paths.length > 1 ? "are" : "is") + " at " + paths.join(", ") + ".";
  return describeNodeIdentity(definition) + " has no slot — declare one on the component first (a frame bound with componentPropertyReferences: { slot }), then fill it here.";
}




// The override plans against the component's DEFINITION sublayers — a create's route, and a
// retargeting edit's. The sublayer a path names is found INSIDE the resolved component (a sync
// walk of a subtree prepare already loaded), which is also what makes a path from a sibling
// variant refuse: it names a real node this component doesn't hold.
function planDefinitionOverrides(component: any, overrides: Record<string, OverrideDeltaInput>, subject: string, gate: GateResources | undefined): OverridePlan[] {
  const plans: OverridePlan[] = [];
  for (const path of Object.keys(overrides)) {
    const where = subject + ".overrides[" + JSON.stringify(path) + "]";
    const id = definitionId(path);
    const definition: any = component.findOne((n: any) => n.id === id);
    if (!definition) {
      throw new Error(
        where + ": " + JSON.stringify(component.name) + " (id " + JSON.stringify(component.id) + ") has no sublayer at that path. " +
          "Paths are component-relative, exactly as flcm.get keys an instance's `overrides` — and each variant has its own; read an instance of THIS variant to see them.",
      );
    }
    // The compile runs against the DEFINITION node: a fresh instance's sublayer is a copy of it
    // (same type, same font, same wrap), and the definition exists before the instance does.
    plans.push(compileOverride(definition, component, overrides[path], path, where, gate, projectedInstanceContextOf(definition, component)));
  }
  return plans;
}

// The fill word splits off FIRST: `children` is not an edit word (the sublayer compile would
// refuse it as a `get` result), and what it carries is built, not written. The rest is the sublayer's
// own delta and compiles as the words it is — a slot's `layout`/`fill` restyle the hole exactly
// as before.
// One override, compiled against the sublayer the route chose (the definition node, or the live
// one) and preflighted against the instance write policy in `context`, where that sublayer will sit.
// With `gate` — the gate's call — font coverage is judged too; without it — prepare's hint — it
// is not. Either way nothing is minted: the apply authorizes the live sublayer it finds.
function compileOverride(
  sublayer: any, definition: any, delta: OverrideDeltaInput, path: string, where: string, gate: GateResources | undefined, context: InstanceContextFacts,
): OverridePlan {
  const { rest, slotContent } = splitSlotContent(sublayer, definition, delta, where);
  // An override that only fills (or only restated the read's `type`) has no words to write, and
  // an empty compile would refuse it; the empty plan still runs the existence gate at apply.
  const words = Object.keys(rest).length ? restoreNullWords(rest, where) : undefined;
  const plan: EditPlan = words ? compileEditPlan(sublayer, words, where) : emptyEditPlan(sublayer);
  const realizeOnly = words ? preflightEditPlan(plan, gate, where, context).realizeOnly : NO_REALIZE_ONLY;
  if (!slotContent) return { path, delta: words, plan, realizeOnly, context };
  // The content's roots are judged against the slot as THIS override will leave it (its own
  // layout words projected, the way a batch projects a parent's delta) — a percent under a hug
  // slot, or a fill-height text in its flow, refuses here with zero writes, not from the span.
  const deltas: BatchLayoutDeltas | undefined = plan.patch.layout ? { [sublayer.id]: plan.patch.layout } : undefined;
  // A live root is judged against the slot where it lands, like every live node it places (live-tree.ts).
  for (const content of slotContent) {
    if (content.liveId === undefined) assertBuiltRootLandsUnderParent(sublayer, content, where + "." + SLOT_CONTENT_WORD, deltas);
    assertBuiltInteriorLegal(content);
  }
  return { path, delta: words, plan, slotContent, realizeOnly, context };
}

// The fill word, taken off the delta and judged against the one authority on what a slot is
// (identity.isSlotHole): legal only when the sublayer at that path IS one, refused naming the
// path and the slots the component has otherwise. The array's shape and its nodes' provenance
// were judged at construction; the falsy entries a children list allows are dropped here.
function splitSlotContent(sublayer: any, definition: any, delta: OverrideDeltaInput, where: string): { rest: OverrideDeltaInput; slotContent?: WriteNode[] } {
  const raw = own(delta, SLOT_CONTENT_WORD);
  const isSlot = isSlotHole(sublayer);
  const rest: OverrideDeltaInput = {};
  for (const key of Object.keys(delta)) {
    if (key === SLOT_CONTENT_WORD) continue;
    // A read spells a slot's `type` as SLOT — what the instance shows — where the node a create
    // compiles against is the definition's bound FRAME. That word is identity, not a claim, so at
    // a slot it folds here instead of tripping the compile's wrong-type check.
    if (key === "type" && isSlot && delta[key] === "SLOT") continue;
    rest[key] = delta[key];
  }
  if (raw === undefined) return { rest };
  if (!isSlot) {
    throw new Error(
      where + ": `" + SLOT_CONTENT_WORD + "` fills a SLOT, and " + describeNodeIdentity(sublayer) + " at that path is not one. " + slotPathsSentence(definition),
    );
  }
  return { rest, slotContent: (raw as WriteChild[]).filter((child): child is WriteNode => !!child) };
}

function restoreNullWords(delta: OverrideDeltaInput, where: string): EditDelta {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(delta)) {
    const value = delta[key];
    if (value !== null) {
      out[key] = value;
      continue;
    }
    const restore = own(NULL_RESTORE, key);
    if (restore === undefined) {
      throw new Error(
        where + ": `" + key + "` is null. A read's null means the instance lacks a field the component has, and flcm has no removal word for `" + key + "` — the ones it has: " +
          Object.keys(NULL_RESTORE).join(", ") + ". Pass a value, or leave the field to the component.",
      );
    }
    out[key] = restore;
  }
  return out as EditDelta;
}

// An override's words land on a sublayer its instance locks, under that sublayer's own parent.
function overrideSite(plan: EditPlan, context: InstanceContextFacts) {
  const parent = plan.node.parent;
  return {
    instance: { ownWritesLockedBy: context.ownWritesLockedBy, isInstanceRoot: false },
    parentMode: layoutModeOf(parent && "layoutMode" in parent ? (parent as { layoutMode?: string }) : undefined),
    onPage: false,
  };
}

/** Every override's realize-only words, as checks against the sublayer each was compiled on. */
export function overrideRealizeOnlyChecks(overrides: readonly OverridePlan[], gate: GateResources, subject: string): RealizeOnlyCheck[] {
  return overrides.flatMap((o) => realizeOnlyChecksOf(o.plan, o.realizeOnly, gate, overrideSite(o.plan, o.context), subject, o.context));
}

/**
 * `checks` on an instance root, minus its direction when the delta retargets it: the gate compared
 * that word to the incoming component's already, and the retarget is what makes it hold.
 */
export function withoutRetargetHeldChecks(checks: readonly RealizeOnlyCheck[], plan: InstanceEditPlan | undefined): RealizeOnlyCheck[] {
  return plan?.retargets ? checks.filter((check) => check.rule !== "instance.root-layout-mode") : [...checks];
}

/**
 * What an instance delta does to the box its override sublayers measure against: the root's own size
 * words, and a retarget's change of size. Projected overrides measure against the incoming
 * component's definition, so the writes are named on it.
 */
export function instanceGeometryWrites(node: SceneNode, rootPatch: WriteProps, plan: InstanceEditPlan): GeometryEffect[] {
  if (!plan.retargets) return geometryWritesOf(node, rootPatch);
  const component = plan.becomes;
  const writes = geometryWritesOf(component, rootPatch);
  if (Math.abs(node.width - component.width) > 0.01) writes.push({ node: component, aspect: "size-h" });
  if (Math.abs(node.height - component.height) > 0.01) writes.push({ node: component, aspect: "size-v" });
  return writes;
}

/** One phase of one override path's writes, as the call's scheduler orders it. */
export interface OverrideOperation extends EditOperation {
  readonly override: OverridePlan;
}

/** What an instance's override operations inherit and wait on, beyond their own sublayers. */
export interface OverrideOperationContext {
  /** The instance's entry in the call. Its retarget, which replaces the tree the paths name, lands first. */
  readonly entry: number;
  /** How a cycle refusal tags the instance's words (`[2]`, a tree path). */
  readonly tag: string;
  /** The component the instance shows once the call's own retarget lands. */
  readonly becomes: { readonly id: string };
  readonly mains: InstanceMains;
  /** The operation that puts the instance where it lands, when another entry's does (a live tree's child). */
  readonly attachedBy?: OperationRef;
  /** The words the paths owe, where the gate schedules before recording them. */
  readonly obligations?: readonly Obligation[];
}

/**
 * Every override's writes as operations, one per phase per path, in the order a path lands them:
 * edit's own phases on the sublayer, and a slot's content between the constraints and the sizes (a
 * hug slot must measure its new content). A path compiled against the definition (a create, a
 * retarget) has no live sublayer yet, so it names no geometry and keeps only the phase order.
 */
export function overrideOperationsOf(instance: SceneNode, overrides: readonly OverridePlan[], at: OverrideOperationContext): OverrideOperation[] {
  const defines = definitionsEditedAt(instance);
  return overrides.flatMap((override) => {
    const layer = liveSublayerId(instance.id, override.path);
    const live = override.context.basis === "live";
    const sublayer = override.plan.node;
    const inherits = definitionsInheritedBy(layer, sublayer.type === "INSTANCE", at.mains).add(at.becomes.id);
    const unwritten = new Set(override.realizeOnly.keys());
    const phases: EditOperationPhase[] = [...EDIT_PLAN_PHASES];
    if (override.slotContent) phases.splice(phases.indexOf("percent-size"), 0, "slot-content");
    return phases.map((phase) => ({
      entry: at.entry, phase, layer, defines, inherits, override, waitsFor: [{ entry: at.entry, layer: instance.id, phase: "retarget" as const }, ...(at.attachedBy ? [at.attachedBy] : [])],
      writes: !live ? [] : phase === "slot-content" ? [{ node: sublayer, aspect: "flow" as const }] : geometryWritesAt(sublayer, override.plan.patch, phase, unwritten),
      reads: live ? writePointGeometryReads(sublayer, phase, at.obligations) : [],
      label: at.tag + " overrides[" + JSON.stringify(override.path) + "] (" + phase + ")",
    }));
  });
}

/**
 * The sealed apply of `instance`'s override operations, one at a time in the order the call's
 * schedule gives. A path's live sublayer is found by the composite id the path predicts, the first
 * time one of its operations runs: re-acquired then, not trusted from the gate, because a swap or a
 * variant write earlier in the same span replaced the tree the paths named. `verb` is what the span
 * reports as — a batch spells its entry into it, so an override that fails names which entry's it was.
 */
export function beginOverrideApply(instance: any, ctx: RenderCtx, verb: string): (operation: OverrideOperation) => void {
  const subject = "flcm." + verb;
  const acquired = new Map<OverridePlan, { editPlan: AuthorizedEditPlan; fail: EditPlanFailure }>();
  const acquire = ({ path, delta, slotContent }: OverridePlan) => {
    const where = subject + ".overrides[" + JSON.stringify(path) + "]";
    const liveId = liveSublayerId(instance.id, path);
    const node = instance.findOne((n: any) => n.id === liveId);
    if (!node) {
      throw new Error(
        where + ": " + describeNodeIdentity(instance) + " has no sublayer at that path — a component word in the same call replaced it (an instance swap, or a variant with a different tree). Apply the component word, read the instance, then override.",
      );
    }
    // The gate judged the path a slot on the tree it could see; a retarget in this span may have
    // put something else there. Asked again on the live node, loud, before a child is touched.
    if (slotContent && node.type !== "SLOT") {
      throw new Error(where + ": " + describeNodeIdentity(node) + " is not a SLOT in the tree this call produced — a component word in the same call replaced it. Apply the component word, read the instance, then fill.");
    }
    // Compiled HERE, against the sublayer the span actually holds — a create's fresh copy, or the
    // tree a retarget just produced — so the words land on what is there, not on the definition
    // node the gate could see. For a non-retargeting edit this is the same node the gate compiled
    // against, and the same answer unless this span's own setProperties moved a bound text's
    // fonts, in which case this answer is the right one. Every refusal from here is a rollback,
    // which is the cost of a fact that does not exist before the seal. A realize-only word that
    // doesn't hold is the finalizer's to name, once every write in the call has landed.
    const editPlan = delta ? gateEditPlan(node, delta, ctx, where) : authorizeEditPlan(emptyEditPlan(node), ctx, where);
    trackEditPlanSizing(editPlan);
    return { editPlan, fail: openEditPlanApply(verb, editPlan, ctx.span) };
  };
  return (operation) => {
    const { override } = operation;
    let landing = acquired.get(override);
    if (!landing) acquired.set(override, (landing = acquire(override)));
    if (operation.phase === "slot-content") placeSlotContent(landing.fail, landing.editPlan.node, override.slotContent!, ctx, subject);
    else applyEditPlanPhase(landing.fail, landing.editPlan, operation.phase as EditPlanPhase, ctx);
  };
}

// A created instance's overrides: their own schedule, since nothing else in the walk writes the sublayers.
function applyOverridePlans(instance: any, overrides: OverridePlan[], component: { id: string }, ctx: RenderCtx, verb: string): void {
  if (!overrides.length) return;
  const operations = overrideOperationsOf(instance, overrides, { entry: 0, tag: "flcm." + verb, becomes: component, mains: new Map() });
  const land = beginOverrideApply(instance, ctx, verb);
  for (const operation of scheduleEditOperations(operations, "flcm." + verb)) land(operation);
}

// Replace a live SLOT's content: every current child goes — the definition's placeholder sublayers
// on a fresh instance, or whatever an earlier fill put there — then the content nodes, in order, through
// the attach-then-size entry every insert rides. Removing a placeholder sublayer is an ASSUMPTION
// on the live checklist: if Figma refuses, the refusal surfaces from this span and the whole call
// rolls back — loud, never a half-filled slot.
function placeSlotContent(fail: EditPlanFailure, slot: any, slotContent: readonly WriteNode[], ctx: RenderCtx, subject: string): void {
  try {
    const facts = liveParentAttachFacts(slot, subject);
    for (const content of slotContent) attachBuiltChild(slot, content, ctx, facts, (child) => slot.appendChild(child));
  } catch (cause) {
    throw fail(cause);
  }
}

// ---- editing a live instance ----

/**
 * One instance delta's component half, resolved. `swapTo` is the component to `swapComponent` to
 * (null when this delta leaves the instance pointing where it points, including when it names the
 * component it already has); `properties` are ready for setProperties; `overrides` are compiled
 * per sublayer. The call's schedule lands them around the node-local phases — see edit-apply.ts.
 *
 * `retargets` is the fact the rest of the pipeline turns on: this delta REPLACES the sublayer tree
 * (a swap, or a variant change Figma re-points through). It decides which sublayers the override
 * plans compile against (the LIVE ones, gated with zero writes — or the incoming definition's,
 * with the live ones only existing inside the span), and it tells a batch that any sibling entry
 * aimed inside this instance is about to be writing to a detached node.
 *
 * `becomesContainer` is the container fact AFTER the retarget — the incoming component's auto-layout
 * mode and wrap, which is what the root's own layout words must be gated against, not the outgoing
 * one's. `undefined` when nothing retargets, meaning "read it off the live node".
 */
export interface InstanceEditPlan {
  swapTo: any | null;
  /** The component the instance points at once this delta lands — the swap's, or a variant change's. */
  becomes: any;
  /**
   * The COMPONENT whose DECLARED properties this delta names by name — null when it names none. A
   * batch reads it to refuse an entry that sets a property another entry is redeclaring in the same
   * call (see assertNoDefinitionBindingCrossReference); it is the VARIANT for a set, so a caller
   * that wants the node the declarations live on goes through definitionOwnerOf. A variant axis is
   * deliberately not counted: a set's axes ARE its members' names, which no `propertyDefinitions`
   * edit can reach, so an axis change depends on nothing a definition entry could move.
   */
  namesDeclaredPropertiesOf: any | null;
  properties: Record<string, string | boolean>;
  overrides: OverridePlan[];
  /** What the slot content among `overrides` needs loaded — empty when none fills a slot. */
  needs: InstanceNeeds;
  retargets: boolean;
  becomesContainer: BecomesContainer | undefined;
  exposed?: boolean;
}

/**
 * The async half of an instance edit: the instance's CURRENT main component — getMainComponentAsync
 * is the one instance fact with no sync read under dynamic-page, so the gate takes it as a handle
 * (null when the component is unreadable; the gate refuses that) — plus every target the words
 * name: the swap target, the swap-typed property values, and the instances inside any slot content.
 */
export async function resolveInstanceEditTargets(node: SceneNode, words: InstanceEditWords, targets: ResolvedTargets): Promise<any | null> {
  const instance: any = node;
  const current: any = await instance.getMainComponentAsync();
  if (words.componentId != null) await targets.resolve(words.componentId);
  // Swap types are read off the component being swapped IN when the delta names one (its
  // definitions are the ones the values are judged against), else the current one.
  const owner = words.componentId != null ? componentNodeOrNull(words.componentId, targets) : current;
  await resolveSwapValueTargets(owner, words.componentProperties || {}, targets);
  for (const path of Object.keys(words.overrides || {})) {
    const content = own(words.overrides![path], SLOT_CONTENT_WORD);
    if (!Array.isArray(content)) continue;
    for (const tree of content as WriteChild[]) if (tree && typeof tree === "object") await resolveInstanceTreeTargets(tree, targets);
  }
  return current;
}

/**
 * The sync half of an instance edit, run in the verb's gate: resolve the property values and every
 * override path against the document as it stands at the seal, and compile the overrides against
 * their sublayers. Everything the component can refuse is refused here, with zero writes.
 */
export function planInstanceEdit(node: SceneNode, words: InstanceEditWords, current: any | null, planning: InstancePlanning, subject: string): InstanceEditPlan {
  const instance: any = node;
  if (words.exposed !== undefined) assertExposureTarget(node, subject);
  if (!current) {
    throw new Error(
      subject + ": " + describeNodeIdentity(instance) + " has no readable main component — it comes from a library the file can't reach right now, so nothing about its properties or sublayers can be resolved.",
    );
  }
  assertInstanceStillOf(instance, current, subject);
  // The base the property names and variant axes are read against: the component being swapped IN
  // when the delta names one, else the instance's CURRENT main (so a partial variant tuple
  // completes from the variant it is on, exactly as Figma's own "keep the rest" does).
  const resolved = words.componentId != null
    ? resolveComponentNode(planning.targets.node(words.componentId, subject), subject)
    : resolvedFromComponent(current);
  const { component, properties, variant } = resolveComponentProperties(resolved, words.componentProperties || {}, subject, planning.targets);
  // The one fact that decides everything downstream: does this delta leave the instance pointing at
  // the component it already points at? A swap to the same component and a variant value restating
  // the current one are both no-ops, and the sublayer tree the override paths name is unchanged.
  const retargets = component !== current;
  const swapTo = words.componentId != null && retargets ? component : null;
  const overrides = retargets
    ? planDefinitionOverrides(component, words.overrides || {}, subject, planning.gate)
    : planLiveOverrides(instance, component, words.overrides || {}, subject, planning.gate);
  return {
    swapTo,
    becomes: component,
    namesDeclaredPropertiesOf: Object.keys(properties).length ? component : null,
    // With no swap the variant axes ride setProperties — Figma re-points the instance itself, keeps
    // its id, and carries the overrides it can. With one, the swap already landed on the exact
    // variant the combination names, so restating the axes would be a second write for nothing.
    properties: swapTo ? properties : { ...properties, ...variant },
    overrides,
    needs: planSlotContentNeeds(overrides.flatMap((o) => o.slotContent || []), planning),
    retargets,
    // The same fact create's own gate reads (planInstanceNode above): the RESOLVED component's mode, not
    // the instance's current one, which the retarget is about to replace.
    becomesContainer: retargets ? { mode: layoutModeOf(component), wrap: component.layoutWrap === "WRAP" } : undefined,
    exposed: words.exposed,
  };
}

// `current` is the one handle the gate takes from prepare rather than reading live: the main
// component has no sync read under dynamic-page. So the gate proves it by the one sync fact that
// mirrors it — an instance's sublayers carry its component's ids, prefixed (liveSublayerId), and
// a swap or variant change during the loads re-points every one of them. Without this, a delta
// naming the component the instance HAD would plan as a no-op against the one it has now, and
// report success for a swap that never happened.
//
// Negative space: an empty component has no sublayers to compare, so a swap between two empty
// components passes. There is nothing to override on one, and its property writes are gated
// against the component the delta names.
function assertInstanceStillOf(instance: any, current: any, subject: string): void {
  if (instanceStillShows(instance, current)) return;
  throw new Error(
    subject + ": the main component of " + describeNodeIdentity(instance) + " changed while this call was resolving targets and loading resources (it was " +
      describeNodeIdentity(current) + "), so the delta was planned against a component the instance no longer has. Nothing was applied — re-read the instance and re-run the call.",
  );
}

/** Whether `instance`'s sublayers are still `component`'s, prefixed: the sync proof of a main component prepare resolved. */
export function instanceStillShows(instance: any, component: any): boolean {
  const live: string[] = instance.children.map((c: any) => c.id);
  const expected: string[] = component.children.map((c: any) => liveSublayerId(instance.id, componentPath(c.id)));
  return live.length === expected.length && live.every((id, i) => id === expected[i]);
}

// An edit's override paths, resolved against the tree the delta leaves alone.
//
// When the delta RETARGETS the instance (a swap, or a variant change) the sublayers the paths name
// don't exist yet — the ones on the canvas belong to the outgoing component — so the compile runs
// against the incoming component's definition nodes, exactly as create's does
// (planDefinitionOverrides), and the apply span re-acquires the live sublayer after the retarget
// lands. Otherwise the live sublayer IS the target and is compiled against directly, here: it
// carries the live font and the live wrap mode, which is what a text delta's font enrichment and a
// clamp's bounded-width gate need to read.
function planLiveOverrides(
  instance: any, component: any, overrides: Record<string, OverrideDeltaInput>, subject: string, gate: GateResources | undefined,
): OverridePlan[] {
  const plans: OverridePlan[] = [];
  for (const path of Object.keys(overrides)) {
    const where = subject + ".overrides[" + JSON.stringify(path) + "]";
    const liveId = liveSublayerId(instance.id, path);
    const live: any = instance.findOne((n: any) => n.id === liveId);
    if (!live) {
      throw new Error(
        where + ": " + describeNodeIdentity(instance) + " has no sublayer at that path. " +
          "Paths are component-relative, exactly as flcm.get keys this instance's `overrides` — and each variant has its own; read the instance to see the ones it has.",
      );
    }
    plans.push(compileOverride(live, component, overrides[path], path, where, gate, instanceContextOf(live)));
  }
  return plans;
}

/**
 * The first half of the sealed apply: re-point the instance, then set its property values. Runs
 * BEFORE the node-local writes so this delta's own root words land on top of what the new component
 * brought, and before the overrides so their sublayers are the ones the retarget produced.
 */
export function applyInstanceRetarget(fail: EditPlanFailure, node: SceneNode, plan: InstanceEditPlan): void {
  const instance: any = node;
  try {
    if (plan.swapTo) instance.swapComponent(plan.swapTo);
    // A value the instance already shows is not set again, since setting it pins it as an override
    // where it was inherited.
    const names = Object.keys(plan.properties);
    const at = realizeAtWritePoint(node, [
      ...(plan.exposed === undefined ? [] : ["word:exposed" as const]), ...names.map((name) => `word:property:${name}` as const),
    ]);
    if (plan.exposed !== undefined && at.writes.has("word:exposed")) instance.isExposedInstance = plan.exposed;
    const properties = Object.fromEntries(names.filter((name) => at.writes.has(`word:property:${name}`)).map((name) => [name, plan.properties[name]]));
    if (Object.keys(properties).length) instance.setProperties(properties);
    at.landed();
  } catch (cause) {
    throw fail(cause);
  }
}

