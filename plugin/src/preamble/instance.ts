// instance — the PREPARE half of flcm.instance: everything an instance spec carries raw (ir.ts
// WriteProps on why) resolved against the live document before a verb's entry seal, so that the
// build walk (bridge.buildInstance) is a sync sequence of writes with nothing left to look up.
// Every refusal here fires with zero writes, and names the component's OWN vocabulary — its real
// property names, the variant combinations it actually has, the sublayer paths it actually holds —
// because the agent is authoring against a definition it can't see.
//
// One shared authority for the property rules, so what an instance is created with and what an
// instance edit sets (capability 2) can't drift: both resolve names, types and variants here.

import { WriteNode, WriteChild, ComponentPropertyInput, OverrideDeltaInput, Target } from "./ir.js";
import { resolveTarget } from "./read.js";
import { isRowColumnAutoLayout, InstancePlan, InstancePlans, RenderResources } from "./bridge.js";
import { assertLayoutRealizableForType } from "./layout-legality.js";
import {
  EditPlan, compileEditPlan, assertEditPlanStillApplies, openEditPlanApply,
  applyEditPlanWrites, settleEditPlanSizes, settleEditPlanPositions,
} from "./edit.js";
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

interface OverridePlan { path: string; plan: EditPlan }

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
  const resolved = await resolveComponentTarget(wn.component as Target);
  const { component, properties } = await resolveComponentProperties(resolved, wn.componentProperties || {});
  // The root's layout words are legal or not by the COMPONENT's mode — the same live fact edit
  // reads off its target. Judged here, not in the constructor, because that is where it's known.
  if (wn.layout) assertLayoutRealizableForType("INSTANCE", wn.layout, isRowColumnAutoLayout(component), SUBJECT);
  const overrides = await resolveOverridePaths(component, wn.overrides || {});
  return {
    plan: {
      component,
      properties,
      applyOverrides: (instance, resources) => applyOverridePlans(instance, overrides, resources),
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

async function resolveComponentTarget(target: Target): Promise<ResolvedComponent> {
  const node: any = await resolveTarget(target);
  if (node.type === "COMPONENT_SET") return { base: node.defaultVariant, set: node };
  if (node.type === "COMPONENT") {
    const set = node.parent && node.parent.type === "COMPONENT_SET" ? node.parent : null;
    return { base: node, set };
  }
  const who = node.type + " " + JSON.stringify(node.name) + " (id " + JSON.stringify(node.id) + ")";
  if (node.type === "INSTANCE") {
    throw new Error(
      SUBJECT + ": " + who + " is itself an instance, not a component. Pass the component it comes from — flcm.get(" + JSON.stringify(node.id) + ") reports it as `componentId`.",
    );
  }
  throw new Error(SUBJECT + ": " + who + " is not a component — only a COMPONENT (or a COMPONENT_SET, whose variant the `componentProperties` pick) can be instantiated.");
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
function resolvePropertyName(authored: string, definitions: Record<string, any>): string {
  if (own(definitions, authored) !== undefined) return authored;
  const matches = Object.keys(definitions).filter((full) => bareName(full) === authored);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      SUBJECT + ".componentProperties: " + JSON.stringify(authored) + " names " + matches.length + " properties on this component (" +
        matches.map((m) => JSON.stringify(m)).join(", ") + ") — use the full name with its #suffix.",
    );
  }
  const available = Object.keys(definitions);
  throw new Error(
    SUBJECT + ".componentProperties: this component has no property " + JSON.stringify(authored) + " — " +
      (available.length ? "its properties are " + available.map((n) => JSON.stringify(bareName(n))).join(", ") : "it defines no properties") + ".",
  );
}

async function resolveComponentProperties(
  resolved: ResolvedComponent, authored: Record<string, ComponentPropertyInput>,
): Promise<{ component: any; properties: Record<string, string | boolean> }> {
  const definitions = definitionsOf(resolved);
  const properties: Record<string, string | boolean> = {};
  const variant: Record<string, string> = {};
  for (const name of Object.keys(authored)) {
    const full = resolvePropertyName(name, definitions);
    const def = definitions[full];
    const value = authored[name];
    const where = SUBJECT + ".componentProperties[" + JSON.stringify(name) + "]";
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
        throw new Error(where + ": " + JSON.stringify(full) + " is a slot — its content is authored, not set as a value. Fill it through `overrides` at the slot's path.");
      default:
        throw new Error(where + ": " + JSON.stringify(full) + " is a " + String(def.type) + " property, which flcm has no word for.");
    }
  }
  const component = Object.keys(variant).length ? selectVariant(resolved, variant) : resolved.base;
  return { component, properties };
}

// The whole variant combination is validated against the set's children — a partial that Figma
// would resolve by "keep the rest of the current variant" is completed the same way here (from
// the base's own axes), then must name EXACTLY one variant. The set's own child list is the
// authority, not the axis options: an axis may list an option no combination actually has.
function selectVariant(resolved: ResolvedComponent, variant: Record<string, string>): any {
  const { base, set } = resolved;
  if (!set) {
    throw new Error(SUBJECT + ".componentProperties: " + JSON.stringify(base.name) + " is a standalone component with no variant axes, but a variant value was named.");
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
    throw new Error(SUBJECT + ".componentProperties: " + JSON.stringify(set.name) + " has no variant " + spelled + " — its variants are " + has + ".");
  }
  throw new Error(SUBJECT + ".componentProperties: " + JSON.stringify(set.name) + " has " + matches.length + " variants named " + spelled + " (the set has a conflict Figma flags) — resolve it in the file, or pass the variant's own id as the component.");
}

// ---- the overrides ----

// A path is component-relative (core's rule, mirrored: a single segment IS the definition node's
// id, two or more take one leading `I`). The node it names must exist AND sit inside the resolved
// component — a path from a sibling variant resolves to a real node that this instance won't have.
function definitionIdOf(path: string): string {
  return path.indexOf(";") !== -1 ? "I" + path : path;
}

function isInside(node: any, ancestor: any): boolean {
  for (let p = node.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

async function resolveOverridePaths(component: any, overrides: Record<string, OverrideDeltaInput>): Promise<OverridePlan[]> {
  const plans: OverridePlan[] = [];
  for (const path of Object.keys(overrides)) {
    const where = SUBJECT + ".overrides[" + JSON.stringify(path) + "]";
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
// a number about to move). The live sublayer is found by the composite id the path predicts.
function applyOverridePlans(instance: any, overrides: OverridePlan[], resources: RenderResources): void {
  const live = overrides.map(({ path, plan }) => {
    const liveId = "I" + instance.id + ";" + path;
    const node = instance.findOne((n: any) => n.id === liveId);
    if (!node) {
      throw new Error(SUBJECT + ".overrides[" + JSON.stringify(path) + "]: the created instance has no sublayer at that path — a component property in the same call replaced it (an instance swap, or a variant with a different tree). Set the property, read the instance, then override.");
    }
    const editPlan: EditPlan = { node, patch: plan.patch, liveTextFacts: undefined };
    // The live gates ran in prepare against the definition; here only existence is re-checked.
    assertEditPlanStillApplies(editPlan, SUBJECT);
    return { editPlan, fail: openEditPlanApply("render", editPlan) };
  });
  for (const { editPlan, fail } of live) applyEditPlanWrites(fail, editPlan, resources);
  for (const { editPlan, fail } of live) settleEditPlanSizes(fail, editPlan);
  for (const { editPlan, fail } of live) settleEditPlanPositions(fail, editPlan);
}
