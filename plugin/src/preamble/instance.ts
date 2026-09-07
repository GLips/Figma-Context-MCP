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
// flcm.detach lives here too: it is the one verb that ENDS an instance, and it reads the same
// facts (the ancestor chain Figma restricts overrides by).

import { WriteNode, WriteChild, ComponentPropertyInput, InstanceEditWords, OverrideDeltaInput, Target, Handle } from "./ir.js";
import { resolveTarget } from "./read.js";
import { isRowColumnAutoLayout, mintHandle, InstancePlan, InstancePlans, RenderResources } from "./bridge.js";
import { assertLayoutRealizableForType } from "./layout-legality.js";
import {
  EditPlan, EditPlanFailure, compileEditPlan, assertEditPlanStillApplies, openEditPlanApply,
  applyEditPlanWrites, settleEditPlanSizes, settleEditPlanPositions,
} from "./edit-plan.js";
import { enterMutatingVerb } from "./mutation-lock.js";
import { beginMutatingApply } from "./verb-error.js";
import { instanceAncestorOf, describeNodeIdentity } from "./identity.js";
import { EditFontNeed } from "./fonts.js";
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

/** One sublayer's override: the component-relative path, and the delta compiled for it. */
export interface OverridePlan { path: string; plan: EditPlan }


/**
 * Resolve every INSTANCE spec in `tree`. Returns the plans (by WriteNode identity) and the font
 * needs the override deltas add, for the caller's one font load.
 */
export async function prepareInstancePlans(tree: WriteNode): Promise<{ plans: InstancePlans; fontNeeds: EditFontNeed[] }> {
  const plans = new Map<WriteNode, InstancePlan>();
  const fontNeeds: EditFontNeed[] = [];
  const specs: WriteNode[] = [];
  collectInstanceSpecs(tree, specs);
  for (const wn of specs) {
    const { plan, overrides } = await prepareOne(wn);
    plans.set(wn, plan);
    for (const o of overrides) fontNeeds.push(o.plan);
  }
  return { plans, fontNeeds };
}

function collectInstanceSpecs(wn: WriteChild, out: WriteNode[]): void {
  if (!wn || typeof wn !== "object") return;
  if (wn.type === "INSTANCE") out.push(wn);
  for (const child of wn.children || []) collectInstanceSpecs(child, out);
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
      applyOverrides: (instance, resources) => applyOverridePlans(instance, overrides, resources, "render"),
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

// The definitions live on the set (for a variant) or the standalone component. A variant's own
// `componentPropertyDefinitions` throws in the live API, so the read goes to the owner.
function definitionsOf({ base, set }: ResolvedComponent): Record<string, any> {
  return (set || base).componentPropertyDefinitions || {};
}

const bareName = (full: string): string => {
  const hash = full.lastIndexOf("#");
  return hash === -1 ? full : full.slice(0, hash);
};

// An authored name resolves to Figma's suffixed one: exact first, else the ONE definition whose
// bare name matches. Two definitions sharing a bare name (legal in Figma — the suffix is the
// identity) refuse rather than guess, listing both full names so the agent can pick.
function resolvePropertyName(authored: string, definitions: Record<string, any>, subject: string): string {
  if (own(definitions, authored) !== undefined) return authored;
  const matches = Object.keys(definitions).filter((full) => bareName(full) === authored);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      subject + ".componentProperties: " + JSON.stringify(authored) + " names " + matches.length + " properties on this component (" +
        matches.map((m) => JSON.stringify(m)).join(", ") + ") — use the full name with its #suffix.",
    );
  }
  const available = Object.keys(definitions);
  throw new Error(
    subject + ".componentProperties: this component has no property " + JSON.stringify(authored) + " — " +
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
  const definitions = definitionsOf(resolved);
  const properties: Record<string, string | boolean> = {};
  const variant: Record<string, string> = {};
  for (const name of Object.keys(authored)) {
    const full = resolvePropertyName(name, definitions, subject);
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
        // Deliberately points at no route: filling an instance's slot is not authorable yet. Its
        // content is appended INTO it, and an instance's child list is closed to plugins — and an
        // `overrides` delta at the slot's path can only restyle the hole, never fill it. Saying so
        // is the whole value here; naming a word that doesn't work costs the agent a round trip.
        throw new Error(
          where + ": " + JSON.stringify(full) + " is a slot — its content is placed INTO it, not set as a value, and flcm has no word for filling one yet (an instance's child list is closed to plugins). " +
            "Put the content in the component's own placeholder frame, or fill this instance's slot by hand in Figma.",
        );
      default:
        throw new Error(where + ": " + JSON.stringify(full) + " is a " + String(def.type) + " property, which flcm has no word for.");
    }
  }
  const component = Object.keys(variant).length ? selectVariant(resolved, variant, subject) : resolved.base;
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
    const plan = compileEditPlan(definition, restoreNullWords(overrides[path], where), where);
    plans.push({ path, plan });
  }
  return plans;
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
function applyOverridePlans(instance: any, overrides: OverridePlan[], resources: RenderResources, verb: string): void {
  const subject = "flcm." + verb;
  const live = overrides.map(({ path, plan }) => {
    const liveId = liveSublayerIdOf(instance.id, path);
    const node = instance.findOne((n: any) => n.id === liveId);
    if (!node) {
      throw new Error(
        subject + ".overrides[" + JSON.stringify(path) + "]: " + describeNodeIdentity(instance) + " has no sublayer at that path — a component word in the same call replaced it (an instance swap, or a variant with a different tree). Apply the component word, read the instance, then override.",
      );
    }
    // Existence-only, always — `liveTextFacts: undefined` on purpose. The freshness gate belongs to
    // PREPARE (assertOverridePlansStillApply, run there for every non-retargeting edit), where a
    // stale sublayer rejects with zero writes; re-asking it here would turn that into a
    // commit-then-undo rollback, and worse, the facts can have moved INSIDE this span by our own
    // earlier writes (a bound `characters` set by setProperties re-derives a mixed text's range
    // fonts, which is not a document race at all).
    const editPlan: EditPlan = { node, patch: plan.patch, liveTextFacts: undefined };
    assertEditPlanStillApplies(editPlan, subject);
    return { editPlan, fail: openEditPlanApply(verb, editPlan) };
  });
  for (const { editPlan, fail } of live) applyEditPlanWrites(fail, editPlan, resources);
  for (const { editPlan, fail } of live) settleEditPlanSizes(fail, editPlan);
  for (const { editPlan, fail } of live) settleEditPlanPositions(fail, editPlan);
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
  properties: Record<string, string | boolean>;
  overrides: OverridePlan[];
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
  return {
    swapTo,
    // With no swap the variant axes ride setProperties — Figma re-points the instance itself, keeps
    // its id, and carries the overrides it can. With one, the swap already landed on the exact
    // variant the combination names, so restating the axes would be a second write for nothing.
    properties: swapTo ? properties : { ...properties, ...variant },
    overrides: await resolveEditOverridePaths(instance, component, retargets, words.overrides || {}, subject),
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
    plans.push({ path, plan: compileEditPlan(live, restoreNullWords(overrides[path], where), where) });
  }
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
 * span reports as, the same spelling the entry's own failure builder was opened with.
 */
export function applyInstanceOverrides(node: SceneNode, plan: InstanceEditPlan, resources: RenderResources, verb: string): void {
  if (!plan.overrides.length) return;
  applyOverridePlans(node as any, plan.overrides, resources, verb);
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
