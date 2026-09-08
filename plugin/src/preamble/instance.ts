// instance — the component half of the write path, for BOTH verbs that touch one:
//
//   • CREATE (flcm.instance): everything an instance spec carries raw (ir.ts WriteProps on why)
//     resolved against the live document before render's entry seal, so that the build walk
//     (bridge.buildInstance) is a sync sequence of writes with nothing left to look up.
//   • EDIT (flcm.edit / editMany on an INSTANCE target): the same three words as a delta —
//     `componentProperties`, `overrides`, and `componentId`, which under edit SWAPS the component.
//     Read words are write words: what `get` reports on an instance is what changes it, so there is
//     no separate variant/swap verb.
//
// Every refusal here fires with zero writes, and names the component's OWN vocabulary — its real
// property names, the variant combinations it actually has, the sublayer paths it actually holds —
// because the agent is authoring against a definition it can't see.
//
// One shared authority for the property rules, so what an instance is created with and what an
// instance edit sets can't drift: both resolve names, types and variants through the same functions.
// The one place they diverge is deliberate and named at resolveEditOverridePaths — a create's
// override compiles against the component's DEFINITION node (the instance doesn't exist yet), while
// an edit that leaves the instance pointing where it already points compiles against the LIVE
// sublayer, which is the real target and carries the real font and wrap.
//
// A SLOT is filled from here too. Read words are write words: `get` republishes a filled slot's
// content as `children` under the slot's path in `overrides`, and stating `children` at that path
// — at create or under edit — is what fills one. The specs are built inside the instance's own
// sealed span through the same attach-then-size entry every insert rides (bridge.attachSpecChild),
// so slot content lands exactly as appended content does; afterwards the structural verbs treat
// it as the ordinary tree it is (structure.ts's gate knows a SLOT's child list is open).
//
// flcm.detach lives here too: it is the one verb that ENDS an instance, and it reads the same
// facts (the ancestor chain Figma restricts overrides by).

import { WriteNode, WriteChild, ComponentPropertyInput, InstanceEditWords, OverrideDeltaInput, Target, Handle } from "./ir.js";
import { resolveTarget } from "./read.js";
import {
  isRowColumnAutoLayout, mintHandle, attachSpecChild, liveParentSpecFacts, assertSpecRootLandsUnderParent,
  InstancePlan, RenderCtx, RenderResources, BatchLayoutDeltas,
} from "./bridge.js";
import { assertLayoutRealizableForType } from "./layout-legality.js";
import {
  EditPlan, EditPlanFailure, InstanceNeeds, compileEditPlan, assertEditPlanStillApplies, openEditPlanApply,
  applyEditPlanWrites, settleEditPlanSizes, settleEditPlanPositions,
} from "./edit-plan.js";
import { enterMutatingVerb } from "./mutation-lock.js";
import { beginMutatingApply } from "./verb-error.js";
import {
  instanceAncestorOf, describeNodeIdentity, definitionOwnerOf, propertyDefinitionsOf, isSlotHole, SLOT_CONTENT_WIRE_KEY,
} from "./identity.js";
import { SLOT_CONTENT_WORD } from "./flcm.js";
import { own } from "./validate.js";
import type { EditDelta } from "./schema.js";

const SUBJECT = "flcm.instance";

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
 * One sublayer's override: the component-relative path, the sublayer's own words compiled for it
 * (an empty patch when the override only fills a slot — the existence gate still runs on it), and,
 * at a SLOT's path, the content the override states: the specs to build there, in order.
 */
export interface OverridePlan { path: string; plan: EditPlan; slotContent?: WriteNode[] }

/**
 * Resolve every INSTANCE spec in `tree` — the tree's own, and every one inside the slot content its
 * instances fill, however deep (a nested instance inside a slot fills ITS slot through the same
 * path). Returns the plans (by WriteNode identity), the font needs the override deltas add, and the
 * slot content trees, for the caller's one font load and one image request.
 */
export async function prepareInstancePlans(tree: WriteNode): Promise<InstanceNeeds> {
  const needs: InstanceNeeds = { plans: new Map(), fontNeeds: [], slotContentTrees: [] };
  const specs: WriteNode[] = [];
  collectInstanceSpecs(tree, specs);
  for (const wn of specs) {
    const { plan, overrides } = await prepareOne(wn);
    needs.plans.set(wn, plan);
    for (const o of overrides) {
      needs.fontNeeds.push(o.plan);
      if (o.slotContent) needs.slotContentTrees.push(...o.slotContent);
    }
  }
  return needs;
}

// Descends into slot content as well as children: a `flcm.instance` inside an override's `children`
// is an instance spec like any other, and the build walk will ask for its plan by identity.
function collectInstanceSpecs(wn: WriteChild, out: WriteNode[]): void {
  if (!wn || typeof wn !== "object") return;
  if (wn.type === "INSTANCE") out.push(wn);
  for (const child of wn.children || []) collectInstanceSpecs(child, out);
  for (const content of slotContentSpecsOf(wn)) for (const child of content) collectInstanceSpecs(child, out);
}

// Every `children` array an instance spec's overrides carry — the raw word, shape-checked at
// construction (flcm.compileOverrideBag) and resolved to a slot here.
function slotContentSpecsOf(wn: WriteNode): WriteChild[][] {
  const out: WriteChild[][] = [];
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
async function prepareSlotContentNeeds(content: readonly WriteNode[]): Promise<InstanceNeeds> {
  const needs: InstanceNeeds = { plans: new Map(), fontNeeds: [], slotContentTrees: [...content] };
  for (const tree of content) {
    const nested = await prepareInstancePlans(tree);
    nested.plans.forEach((plan, wn) => needs.plans.set(wn, plan));
    needs.fontNeeds.push(...nested.fontNeeds);
    needs.slotContentTrees.push(...nested.slotContentTrees);
  }
  return needs;
}

async function prepareOne(wn: WriteNode): Promise<{ plan: InstancePlan; overrides: OverridePlan[] }> {
  const resolved = await resolveComponentTarget(wn.component as Target, SUBJECT);
  const { component, properties } = await resolveComponentProperties(resolved, wn.componentProperties || {}, SUBJECT);
  // The root's layout words are legal or not by the COMPONENT's mode — the same live fact edit
  // reads off its target. Judged here, not in the constructor, because that is where it's known.
  if (wn.layout) assertLayoutRealizableForType("INSTANCE", wn.layout, isRowColumnAutoLayout(component), SUBJECT);
  const overrides = await resolveOverridePaths(component, wn.overrides || {}, SUBJECT);
  return {
    plan: {
      component,
      // A create stamps the exact variant (`component` above), so the variant axes are not restated
      // as property writes — only the non-variant values are.
      properties,
      applyOverrides: (instance, ctx) => applyOverridePlans(instance, overrides, ctx, "render"),
    },
    overrides,
  };
}

// ---- the component ----

export interface ResolvedComponent {
  /** The component to stamp before any variant selection: a set's default, or the named one. */
  base: any;
  /** The set, when the base is a variant — the owner of the property definitions. */
  set: any | null;
}

// A live COMPONENT, plus the set that owns its property definitions when it is a variant.
function resolvedFromComponent(node: any): ResolvedComponent {
  return { base: node, set: node.parent && node.parent.type === "COMPONENT_SET" ? node.parent : null };
}

/**
 * A target naming a component, resolved. Exported because every verb that takes one rides it —
 * flcm.instance's positional component, an instance-swap property's value, and flcm.component's
 * `instance_swap` default — so they all refuse an INSTANCE (or a plain frame) with one sentence.
 */
export async function resolveComponentTarget(target: Target, subject: string): Promise<ResolvedComponent> {
  const node: any = await resolveTarget(target);
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


/** Figma files a property under `Label#12:3`; the bare name is what an author writes and reads. */
export const bareName = (full: string): string => {
  const hash = full.lastIndexOf("#");
  return hash === -1 ? full : full.slice(0, hash);
};

/**
 * Every definition an authored name could mean: the exact full name if it is one, else every
 * definition sharing that bare name. Zero, one, or (legally, since the suffix is the identity) more.
 *
 * Split from resolvePropertyName because an EDIT of `propertyDefinitions` forks on the count rather
 * than refusing it — a name that matches nothing ADDS a property, where every other caller is
 * addressing one that must already exist.
 */
export function matchPropertyNames(authored: string, definitions: Record<string, any>): string[] {
  if (own(definitions, authored) !== undefined) return [authored];
  return Object.keys(definitions).filter((full) => bareName(full) === authored);
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
async function resolveComponentProperties(
  resolved: ResolvedComponent, authored: Record<string, ComponentPropertyInput>, subject: string,
): Promise<{ component: any; properties: Record<string, string | boolean>; variant: Record<string, string> }> {
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
        const swap: any = await resolveTarget(value as Target);
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
    const path = hole ? JSON.stringify(componentPathOfDefinitionId(hole.id)) : '"<slotPath>"';
    throw new Error(
      slotNamed.where + ": " + JSON.stringify(slotNamed.full) + " is a slot, and a slot has no value — its content is stated as `children` at the slot's path: " +
        subject + ".overrides[" + path + "] = { children: [ …specs ] } (flcm.frame/text/instance…; [] empties it).",
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

// A path is component-relative (core's rule, mirrored: a single segment IS the definition node's
// id, two or more take one leading `I`). The node it names must exist AND sit inside the resolved
// component — a path from a sibling variant resolves to a real node that this instance won't have.
function definitionIdOf(path: string): string {
  return path.indexOf(";") !== -1 ? "I" + path : path;
}

// The inverse: a definition node's own id, as the path `get` keys an instance's `overrides` by.
function componentPathOfDefinitionId(id: string): string {
  return id.charAt(0) === "I" && id.indexOf(";") !== -1 ? id.slice(1) : id;
}

// The frame bound to a slot property in ONE definition, or null. The variant's own subtree, not
// the set's: each variant realizes the set's slot with its own frame.
function slotFrameBoundTo(definition: any, full: string): any | null {
  return definition.findOne((n: any) => own((n.componentPropertyReferences || {}) as Record<string, string>, SLOT_CONTENT_WIRE_KEY) === full);
}

// The slot paths a definition HAS — what a `children` at the wrong path is told instead.
function slotPathsSentence(definition: any): string {
  const paths = (definition.findAll((n: any) => isSlotHole(n)) as any[]).map((n) => JSON.stringify(componentPathOfDefinitionId(n.id)));
  if (paths.length) return "The slot" + (paths.length > 1 ? "s" : "") + " of " + describeNodeIdentity(definition) + " " + (paths.length > 1 ? "are" : "is") + " at " + paths.join(", ") + ".";
  return describeNodeIdentity(definition) + " has no slot — declare one on the component first (a frame bound with componentPropertyReferences: { slot }), then fill it here.";
}

// The live sublayer a path names inside one instance — the composite id Figma mints and `get`
// documents (`I<instanceId>;<path>`). Exactly ONE leading `I` however deep: a NESTED instance's own
// id already carries it (`I12:3;4:5`), so its sublayer is `I12:3;4:5;6:7`, not `II12:3;…`. Same rule
// as core's componentPath/definitionId, which is the read side of this string.
function liveSublayerIdOf(instanceId: string, path: string): string {
  return (instanceId.charAt(0) === "I" ? instanceId : "I" + instanceId) + ";" + path;
}

function isInside(node: any, ancestor: any): boolean {
  for (let p = node.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

/**
 * Two override paths in one delta, where one sits INSIDE a slot the other fills: refused, naming
 * both paths, with zero writes.
 *
 * A fill REPLACES the slot's content — every current child is removed (replaceSlotContent) — and
 * the sublayer the other path names is one of them. The words would land in stage 5a and the node
 * would be deleted moments later in the same span, and Figma keeps accepting writes on a removed
 * node, so the call would report success for a write that landed on nothing. Ordering the two
 * differently is not an answer: the delta never says which it meant, and the layer the fill
 * installs is a different node from the one the path names. The content spec is where those words
 * belong. `editMany`'s cross-ENTRY version of the same contradiction lives in edit-many.ts.
 */
function assertNoOverridePathInsideFilledSlot(plans: readonly OverridePlan[], subject: string): void {
  const filled = plans.filter((plan) => plan.slotContent);
  if (!filled.length) return;
  for (const plan of plans) {
    for (const slot of filled) {
      if (plan === slot || !isInside(plan.plan.node, slot.plan.node)) continue;
      throw new Error(
        subject + ".overrides[" + JSON.stringify(plan.path) + "]: " + describeNodeIdentity(plan.plan.node) +
          " sits inside the slot at " + JSON.stringify(slot.path) + ", whose `" + SLOT_CONTENT_WORD +
          "` this same call replaces — the fill removes that layer, so these words would land on a node the call deletes. " +
          "State them on the spec you fill the slot with instead.",
      );
    }
  }
}

async function resolveOverridePaths(component: any, overrides: Record<string, OverrideDeltaInput>, subject: string): Promise<OverridePlan[]> {
  const plans: OverridePlan[] = [];
  for (const path of Object.keys(overrides)) {
    const where = subject + ".overrides[" + JSON.stringify(path) + "]";
    const definition: any = await figma.getNodeByIdAsync(definitionIdOf(path));
    if (!definition || definition.removed || !isInside(definition, component)) {
      throw new Error(
        where + ": " + JSON.stringify(component.name) + " (id " + JSON.stringify(component.id) + ") has no sublayer at that path. " +
          "Paths are component-relative, exactly as flcm.get keys an instance's `overrides` — and each variant has its own; read an instance of THIS variant to see them.",
      );
    }
    // The compile runs against the DEFINITION node: a fresh instance's sublayer is a copy of it
    // (same type, same font, same wrap), and the definition exists before the instance does.
    plans.push(compileOverride(definition, component, overrides[path], path, where));
  }
  assertNoOverridePathInsideFilledSlot(plans, subject);
  return plans;
}

// One override, compiled against the sublayer the route chose (the definition node, or the live
// one). The fill word splits off FIRST: `children` is not an edit word (the sublayer compile would
// refuse it as a read spec), and what it carries is built, not written. The rest is the sublayer's
// own delta and compiles as the words it is — a slot's `layout`/`fill` restyle the hole exactly
// as before.
function compileOverride(sublayer: any, definition: any, delta: OverrideDeltaInput, path: string, where: string): OverridePlan {
  const { rest, slotContent } = splitSlotContent(sublayer, definition, delta, where);
  // An override that only fills (or only restated the read's `type`) has no words to write, and
  // an empty compile would refuse it; the empty plan still runs the existence gate at apply.
  const plan: EditPlan = Object.keys(rest).length
    ? compileEditPlan(sublayer, restoreNullWords(rest, where), where)
    : { node: sublayer, patch: {}, liveTextFacts: undefined };
  if (!slotContent) return { path, plan };
  // The content's roots are judged against the slot as THIS override will leave it (its own
  // layout words projected, the way a batch projects a parent's delta) — a percent under a hug
  // slot, or a fill-height text in its flow, refuses here with zero writes, not from the span.
  const deltas: BatchLayoutDeltas | undefined = plan.patch.layout ? { [sublayer.id]: plan.patch.layout } : undefined;
  for (const spec of slotContent) assertSpecRootLandsUnderParent(sublayer, spec, where + "." + SLOT_CONTENT_WORD, deltas);
  return { path, plan, slotContent };
}

// The fill word, taken off the delta and judged against the one authority on what a slot is
// (identity.isSlotHole): legal only when the sublayer at that path IS one, refused naming the
// path and the slots the component has otherwise. The array's shape and its specs' provenance
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

// The sealed apply for one instance's overrides, in edit's own stage order across the WHOLE set
// (writes, then sizes, then positions — a size read while a sibling's writes are still landing is
// a number about to move). The live sublayer is found by the composite id the path predicts —
// re-acquired HERE, not trusted from prepare, because a swap or a variant write earlier in the
// same span replaced the tree the paths named. `verb` is what the span reports as — a batch spells
// its entry into it, so an override that fails names which entry's it was.
//
// THE ORDER a slot fill takes among those stages, decided here and nowhere else: 5a writes for
// every sublayer first — a slot's own `layout`/`fill` words land before its content, so the
// content attaches under the mode it will live in — then each slot's content replaced (a child
// list change belongs after the writes and BEFORE the sizes: a hug slot must measure its new
// content), then 5b sizes, then 5c positions. The content's own percents and anchors ride the
// walk context's pending list, settled by the verb once the whole span has landed.
function applyOverridePlans(instance: any, overrides: OverridePlan[], ctx: RenderCtx, verb: string): void {
  const subject = "flcm." + verb;
  const live = overrides.map(({ path, plan, slotContent }) => {
    const where = subject + ".overrides[" + JSON.stringify(path) + "]";
    const liveId = liveSublayerIdOf(instance.id, path);
    const node = instance.findOne((n: any) => n.id === liveId);
    if (!node) {
      throw new Error(
        where + ": " + describeNodeIdentity(instance) + " has no sublayer at that path — a component word in the same call replaced it (an instance swap, or a variant with a different tree). Apply the component word, read the instance, then override.",
      );
    }
    // Prepare judged the path a slot on the tree it could see; a retarget in this span may have
    // put something else there. Asked again on the live node, loud, before a child is touched.
    if (slotContent && node.type !== "SLOT") {
      throw new Error(where + ": " + describeNodeIdentity(node) + " is not a SLOT in the tree this call produced — a component word in the same call replaced it. Apply the component word, read the instance, then fill.");
    }
    // Existence-only, always — `liveTextFacts: undefined` on purpose. The freshness gate belongs to
    // PREPARE (assertOverridePlansStillApply, run there for every non-retargeting edit), where a
    // stale sublayer rejects with zero writes; re-asking it here would turn that into a
    // commit-then-undo rollback, and worse, the facts can have moved INSIDE this span by our own
    // earlier writes (a bound `characters` set by setProperties re-derives a mixed text's range
    // fonts, which is not a document race at all).
    const editPlan: EditPlan = { node, patch: plan.patch, liveTextFacts: undefined };
    assertEditPlanStillApplies(editPlan, subject);
    return { editPlan, slotContent, fail: openEditPlanApply(verb, editPlan) };
  });
  for (const { editPlan, fail } of live) applyEditPlanWrites(fail, editPlan, ctx);
  for (const { editPlan, slotContent, fail } of live) if (slotContent) replaceSlotContent(fail, editPlan.node, slotContent, ctx, subject);
  for (const { editPlan, fail } of live) settleEditPlanSizes(fail, editPlan);
  for (const { editPlan, fail } of live) settleEditPlanPositions(fail, editPlan);
}

// Replace a live SLOT's content: every current child goes — the definition's placeholder sublayers
// on a fresh instance, or whatever an earlier fill put there — then the specs, in order, through
// the attach-then-size entry every insert rides. Removing a placeholder sublayer is an ASSUMPTION
// on the live checklist: if Figma refuses, the refusal surfaces from this span and the whole call
// rolls back — loud, never a half-filled slot.
function replaceSlotContent(fail: EditPlanFailure, slot: any, specs: readonly WriteNode[], ctx: RenderCtx, subject: string): void {
  try {
    for (const child of [...slot.children]) child.remove();
    const facts = liveParentSpecFacts(slot, subject);
    for (const spec of specs) attachSpecChild(slot, spec, ctx, facts, (child) => slot.appendChild(child));
  } catch (cause) {
    throw fail(cause);
  }
}

// ---- editing a live instance ----

/**
 * One instance delta's component half, resolved. `swapTo` is the component to `swapComponent` to
 * (null when this delta leaves the instance pointing where it points, including when it names the
 * component it already has); `properties` are ready for setProperties; `overrides` are compiled
 * per sublayer. The verb applies them AROUND the node-local stages — see edit.ts.
 *
 * `retargets` is the fact the rest of the pipeline turns on: this delta REPLACES the sublayer tree
 * (a swap, or a variant change Figma re-points through). It decides where the override plans'
 * live gates can run (prepare, with zero writes — or only inside the span, where the sublayers
 * exist), and it tells a batch that any sibling entry aimed inside this instance is about to be
 * writing to a detached node.
 *
 * `becomesRowColumn` is the container fact AFTER the retarget — the incoming component's auto-layout
 * mode, which is what the root's own layout words must be gated against, not the outgoing one's.
 * `undefined` when nothing retargets, meaning "read it off the live node".
 */
export interface InstanceEditPlan {
  swapTo: any | null;
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
  becomesRowColumn: boolean | undefined;
}

/**
 * The PREPARE half of an instance edit: resolve the swap target, the property values, and every
 * override path, against the live document and before the verb's entry seal. Everything the
 * component can refuse is refused here, with zero writes.
 */
export async function prepareInstanceEditPlan(node: SceneNode, words: InstanceEditWords, subject: string): Promise<InstanceEditPlan> {
  const instance: any = node;
  const current: any = await instance.getMainComponentAsync();
  if (!current) {
    throw new Error(
      subject + ": " + describeNodeIdentity(instance) + " has no readable main component — it comes from a library the file can't reach right now, so nothing about its properties or sublayers can be resolved.",
    );
  }
  // The base the property names and variant axes are read against: the component being swapped IN
  // when the delta names one, else the instance's CURRENT main (so a partial variant tuple
  // completes from the variant it is on, exactly as Figma's own "keep the rest" does).
  const resolved = words.componentId != null ? await resolveComponentTarget(words.componentId, subject) : resolvedFromComponent(current);
  const { component, properties, variant } = await resolveComponentProperties(resolved, words.componentProperties || {}, subject);
  // The one fact that decides everything downstream: does this delta leave the instance pointing at
  // the component it already points at? A swap to the same component and a variant value restating
  // the current one are both no-ops, and the sublayer tree the override paths name is unchanged.
  const retargets = component !== current;
  const swapTo = words.componentId != null && retargets ? component : null;
  const overrides = await resolveEditOverridePaths(instance, component, retargets, words.overrides || {}, subject);
  return {
    swapTo,
    namesDeclaredPropertiesOf: Object.keys(properties).length ? component : null,
    // With no swap the variant axes ride setProperties — Figma re-points the instance itself, keeps
    // its id, and carries the overrides it can. With one, the swap already landed on the exact
    // variant the combination names, so restating the axes would be a second write for nothing.
    properties: swapTo ? properties : { ...properties, ...variant },
    overrides,
    needs: await prepareSlotContentNeeds(overrides.flatMap((o) => o.slotContent || [])),
    retargets,
    // The same fact create's own gate reads (prepareOne above): the RESOLVED component's mode, not
    // the instance's current one, which the retarget is about to replace.
    becomesRowColumn: retargets ? isRowColumnAutoLayout(component) : undefined,
  };
}

// An edit's override paths, resolved against whichever tree this delta will leave behind.
//
// When the delta RETARGETS the instance (a swap, or a variant change) the sublayers the paths name
// don't exist yet — the ones on the canvas belong to the outgoing component — so the compile runs
// against the incoming component's definition nodes, exactly as create's does, and the apply span
// re-acquires the live sublayer after the retarget lands. Otherwise the live sublayer IS the target
// and is compiled against directly: it carries the live font and the live wrap mode, which is what
// a text delta's font enrichment and a clamp's bounded-width gate need to read.
async function resolveEditOverridePaths(
  instance: any, component: any, retargets: boolean, overrides: Record<string, OverrideDeltaInput>, subject: string,
): Promise<OverridePlan[]> {
  if (retargets) return resolveOverridePaths(component, overrides, subject);
  const plans: OverridePlan[] = [];
  for (const path of Object.keys(overrides)) {
    const where = subject + ".overrides[" + JSON.stringify(path) + "]";
    const live: any = await figma.getNodeByIdAsync(liveSublayerIdOf(instance.id, path));
    if (!live || live.removed) {
      throw new Error(
        where + ": " + describeNodeIdentity(instance) + " has no sublayer at that path. " +
          "Paths are component-relative, exactly as flcm.get keys this instance's `overrides` — and each variant has its own; read the instance to see the ones it has.",
      );
    }
    plans.push(compileOverride(live, component, overrides[path], path, where));
  }
  assertNoOverridePathInsideFilledSlot(plans, subject);
  return plans;
}

/**
 * Stage 4 for an instance delta's OVERRIDE plans, run in the verb's PREPARE beside the root plan's.
 *
 * Only a delta that leaves the sublayer tree alone can answer it: those plans were compiled against
 * LIVE sublayers, so the freshness snapshot and the layout gate mean the same thing here as they do
 * for any other node — and rejecting here costs zero writes, where the same rejection from inside
 * the span costs a commit-then-undo rollback. A RETARGETING delta has no live sublayers yet; its
 * plans get the existence re-check inside the span (applyOverridePlans), which is all a tree that
 * doesn't exist can be asked.
 */
export function assertOverridePlansStillApply(plan: InstanceEditPlan, subject: string): void {
  if (plan.retargets) return;
  for (const { plan: overridePlan } of plan.overrides) assertEditPlanStillApplies(overridePlan, subject);
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
    if (Object.keys(plan.properties).length) instance.setProperties(plan.properties);
  } catch (cause) {
    throw fail(cause);
  }
}

/**
 * The second half: every override, on sublayers re-acquired after the retarget. `verb` is what the
 * span reports as, the same spelling the entry's own failure builder was opened with. `ctx` is the
 * verb's build walk (bridge.beginRenderWalk) — shared across a batch's entries.
 */
export function applyInstanceOverrides(node: SceneNode, plan: InstanceEditPlan, ctx: RenderCtx, verb: string): void {
  if (!plan.overrides.length) return;
  applyOverridePlans(node as any, plan.overrides, ctx, verb);
}

// ---- detach ----

const DETACH_SUBJECT = "flcm.detach";

/**
 * flcm.detach(target) — break an instance's link to its component. The subtree becomes ordinary
 * layers under a FRAME with a NEW id (every sublayer id changes with it), returned as that frame's
 * handle with fresh geometry. One-way: nothing re-attaches it, so the old ids and any flcm/key
 * addressing them are worth re-reading after.
 */
// A single expression on purpose: the queue slot is reserved before detach() can possibly yield,
// which is the lock's invocation-order guarantee (see enterMutatingVerb) — don't add work above it.
export function detach(target: Target): Promise<Handle> {
  return enterMutatingVerb(
    "detach",
    async () => {
      const node: any = await resolveTarget(target);
      if (node.type !== "INSTANCE") {
        throw new Error(
          DETACH_SUBJECT + ": " + describeNodeIdentity(node) + " is not an instance — there is no component link to break. " +
            (node.type === "COMPONENT" || node.type === "COMPONENT_SET"
              ? "This is the component itself; detach an INSTANCE of it."
              : "flcm.find({ type: \"INSTANCE\" }) locates the instances on the page."),
        );
      }
      // Figma does NOT refuse a nested detach — it WIDENS it: detachInstance on an instance inside
      // another instance "also detaches all ancestors nodes that are instances" (plugin typings).
      // So asking to detach one instance would silently detach three, which is exactly the kind of
      // unasked-for mutation this surface refuses. Gated here so the agent gets the node to act on
      // rather than a canvas it has to reconstruct.
      const host = instanceAncestorOf(node);
      if (host) {
        throw new Error(
          DETACH_SUBJECT + ": " + describeNodeIdentity(node) + " is nested inside instance " + JSON.stringify(host.name) + " (id " + JSON.stringify(host.id) +
            "). Figma's detach on a nested instance ALSO detaches every enclosing instance up the chain, so flcm refuses rather than widen the mutation silently. Detach " +
            JSON.stringify(host.id) + " (the whole outer instance becomes editable layers) if that is what you mean, or edit the component the nested instance comes from.",
        );
      }
      return node;
    },
    (node) => {
      const fail = beginMutatingApply("detach", node);
      try {
        return mintHandle(node.detachInstance());
      } catch (cause) {
        throw fail(cause);
      }
    },
  );
}
