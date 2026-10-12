/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// component-edit — editing the DEFINITION side of a component, which is how every instance of it
// changes at once. There is no verb here: a main component is edited with `flcm.edit` /
// `flcm.editMany` and its sublayers with the structural verbs, exactly as any frame is, and Figma
// carries the change into every instance because that is what a component IS. This module is the
// three things those verbs can't judge without the live document:
//
//   • `propertyDefinitions` under edit — ADD a property (a name the component doesn't have, bound
//     in the same editMany), RENAME one (`name`), or DELETE one (`null`). A default is never a word
//     here: it is the bound layer's content, so changing it means editing that layer.
//   • `componentPropertyReferences` under edit — bind an existing sublayer to a property, or
//     unbind it (`null` per field).
//   • the bindings an authored node carries into an existing component through append/prepend/insertBefore/
//     insertAfter — the one place outside flcm.component where a binding means something.
//
// The split is edit's own (see edit-plan.ts): the sync compile judges the words' SHAPE, everything
// that reads the definitions is decided in the verb's synchronous GATE (planComponentEdit) with zero writes,
// and the apply is a sync span the verb seals — a rename and a recolor of the same component are
// one undo step.
//
// Where the writes sit in that span is a rule, not an accident: definitions land BEFORE the node's
// own words (a rename must be part of the same step as whatever else the delta says), bindings land
// AFTER them (the node has to be what this delta makes it before it is wired to a property).

import { WriteNode, LiveRef, textOfRuns, ComponentEditWords, ComponentPropertyBinding, ComponentPropertyDefinitionEdit, ComponentPropertyDefinitionEdits } from "./ir.js";
import { BoundLiveNode, RenderResources } from "./bridge.js";
import { EditPlan, EditPlanFailure } from "./edit-plan.js";
import {
  PROPERTY_TYPES, PROPERTY_TYPE_WORD_FOR, BINDING_FIELD_WIRE_KEYS, FIELD_FOR_TYPE, PreparedDefinition,
  compilePropertyDefinition, writeBindingReferences, quoted, agreedDefault, FRESH_LAYER_SHOWS, writeInheritedDefault, readableComponentOf, describeBinder, boundLayerValue, bindingsOf, type LiveBindings,
} from "./component.js";
import { resolvePropertyName, matchPropertyNames, bareName, InstanceEditPlan } from "./instance.js";
import { compileBindingEditBag, assertNoComponentPropertyBindings } from "./flcm.js";
import { bindableFieldsOf } from "./vocabulary.js";
import { instanceAncestorOf, editableComponentOwnerOf, variantSetOf, describeNodeIdentity, definitionOwnerOf, propertyDefinitionsOf } from "./identity.js";
import { own } from "./validate.js";

// ---- `propertyDefinitions` under edit ----

/**
 * What an edit does to a component's declarations, fully resolved: every name matched to the full
 * name Figma files it under, every added property's default read off the layers bound to it.
 * Applied in this order — deletes, then renames, then adds — so a delta that frees a name and
 * re-declares it lands the way it reads.
 */
interface ComponentDefinitionEditPlan {
  description?: string;
  /** Full (suffixed) names to delete. */
  deletes: string[];
  renames: { full: string; rename: string }[];
  /** Each add with the default its binders settled — what one addComponentProperty call takes. */
  adds: { add: AddedDefinition; defaultValue: PreparedDefinition["defaultValue"] }[];
}

/**
 * A property an edit ADDS, as the gate first plans it. The object is the property's identity across
 * the batch: the definition plan that mints it and every binding planned against it hold the same
 * one, and the suffixed name only addComponentProperty can hand back is looked up by it
 * (MintedPropertyNames).
 */
export interface AddedDefinition {
  readonly name: string;
  readonly type: string;
  readonly figmaType: PreparedDefinition["figmaType"];
}

/** The suffixed name each add was filed under — the definitions stage's output, the binding stage's input. */
export type MintedPropertyNames = ReadonlyMap<AddedDefinition, string>;

/** A layer a property's default is read off — what it will show once the call lands — as a refusal names it. */
export interface PropertyBinder {
  layer: string;
  /** Undefined for a layer this call creates with the field unwritten: it takes whatever default the property settles on. */
  value: boolean | string | undefined;
}

// How to bind an added property in the same call — the only call that can carry both halves.
function bindInSameBatch(name: string, type: string): string {
  return "add it and bind the layer that shows its value in ONE flcm.editMany: [{ id: component, propertyDefinitions: { " + JSON.stringify(name) + ": { type: " + JSON.stringify(type) + " } } }, " +
    "{ id: layer, componentPropertyReferences: { " + FIELD_FOR_TYPE[type] + ": " + JSON.stringify(name) + " } }] — its default is that layer's content.";
}

// A variant's properties belong to its SET (Figma stores them there, and reading them off the
// variant throws), so an edit aimed at the variant would be aimed at the wrong node — including
// for the agent's mental model, since the change reaches every variant either way.
function assertNotVariantMember(node: any, where: string): void {
  const set = variantSetOf(node);
  if (set) {
    throw new Error(
      where + ": " + describeNodeIdentity(node) + " is a VARIANT, and a set's properties live on the SET — Figma keeps them there, and a change reaches every variant. " +
        "Edit the set instead: flcm.edit(" + JSON.stringify(set.id) + ", { propertyDefinitions: … }).",
    );
  }
}

/**
 * The properties an edit's `propertyDefinitions` ADDS, by name, defaults not yet settled: the first
 * half of a definition edit, split out so editMany can plan its bindings against them before their
 * defaults are read off those very bindings.
 */
export function planAddedDefinitions(node: any, words: ComponentEditWords, subject: string): Map<string, AddedDefinition> {
  const adds = new Map<string, AddedDefinition>();
  const authored = words.propertyDefinitions;
  if (!authored) return adds;
  const where = subject + ".propertyDefinitions";
  assertNotVariantMember(node, where);
  const surviving = survivingDefinitions(node, authored, where).definitions;
  for (const name of Object.keys(authored)) {
    const entry = authored[name];
    if (entry === null || matchPropertyNames(name, surviving).length) continue;
    adds.set(name, planAddedDefinition(name, entry, where + "[" + JSON.stringify(name) + "]"));
  }
  return adds;
}

/**
 * The bag's deletes, resolved, and the live definitions left once they apply. Everything else in
 * the bag is judged against what is LEFT — that is the order the writes land in — so an entry naming
 * only a property the same bag deletes re-declares it rather than restating it, whatever the key order.
 */
function survivingDefinitions(
  node: any, authored: ComponentPropertyDefinitionEdits, where: string,
): { deletes: string[]; definitions: Record<string, any> } {
  const live = propertyDefinitionsOf(node);
  const deletes: string[] = [];
  for (const name of Object.keys(authored)) {
    if (authored[name] !== null) continue;
    const at = where + "[" + JSON.stringify(name) + "]";
    const full = resolvePropertyName(name, live, where);
    assertNotVariantAxis(live[full], full, at, node);
    if (deletes.indexOf(full) !== -1) throw new Error(at + ": another entry of this bag already deletes " + JSON.stringify(full) + " — name each property once.");
    deletes.push(full);
  }
  const definitions: Record<string, any> = {};
  for (const full of Object.keys(live)) if (deletes.indexOf(full) === -1) definitions[full] = live[full];
  return { deletes, definitions };
}

/** The definition half of an edit; editMany calls it directly, with binders gathered across its entries. */
export function planComponentDefinitionEdit(
  node: any, words: ComponentEditWords, subject: string, adds: ReadonlyMap<string, AddedDefinition>, bindersOf: (add: AddedDefinition) => PropertyBinder[],
): ComponentDefinitionEditPlan {
  const plan: ComponentDefinitionEditPlan = { deletes: [], renames: [], adds: [] };
  if (words.description !== undefined) plan.description = words.description;
  const authored = words.propertyDefinitions;
  if (!authored) return plan;
  const where = subject + ".propertyDefinitions";
  assertNotVariantMember(node, where);
  const { deletes, definitions } = survivingDefinitions(node, authored, where);
  plan.deletes = deletes;
  // Every name the bag introduces (a rename's target, an add), with the entry to blame for it.
  const introduced: { name: string; at: string }[] = [];
  const changed = new Map<string, string>();
  for (const name of Object.keys(authored)) {
    const entry = authored[name];
    if (entry === null) continue;
    const at = where + "[" + JSON.stringify(name) + "]";
    const add = adds.get(name);
    if (add) {
      const defaultValue = agreedDefault(add, bindersOf(add), at, { inherited: FRESH_LAYER_SHOWS[add.figmaType], unboundRemedy: bindInSameBatch(name, add.type) });
      plan.adds.push({ add, defaultValue });
      introduced.push({ name, at });
      continue;
    }
    const full = resolvePropertyName(name, definitions, where);
    const twin = changed.get(full);
    if (twin !== undefined) throw new Error(at + ": " + twin + " already names " + JSON.stringify(full) + " — name each property once.");
    changed.set(full, at);
    const rename = planChangedDefinition(full, definitions[full], entry, at, node);
    if (rename === undefined) continue; // restates what the property already is: nothing to write
    plan.renames.push({ full, rename });
    introduced.push({ name: rename, at });
  }
  assertNoIntroducedDuplicate(definitions, plan.renames, introduced);
  return plan;
}

// Judged against the names the bag LEAVES, not one entry at a time, so the outcome can't depend on
// key order: a swap (A→B, B→A) lands, and a rename and an add landing on one name refuse either way.
// Only a name this bag introduces is checked — a duplicate already on the canvas isn't this call's.
function assertNoIntroducedDuplicate(
  surviving: Record<string, any>, renames: readonly { full: string }[], introduced: readonly { name: string; at: string }[],
): void {
  const renamedAway = new Set(renames.map((change) => change.full));
  const kept = new Set(Object.keys(surviving).filter((full) => !renamedAway.has(full)).map(bareName));
  introduced.forEach(({ name, at }, i) => {
    const alsoIntroduced = introduced.some((other, j) => j !== i && other.name === name);
    if (!kept.has(name) && !alsoIntroduced) return;
    throw new Error(
      at + ": " + (kept.has(name) ? "this component already has a property named " : "another entry of this bag also lands on ") + JSON.stringify(name) +
        ". Figma allows the duplicate (the #suffix is the identity) but flcm doesn't — every later reference names a property by name and a duplicate has no way to say which.",
    );
  });
}

// A variant axis is not a property anyone declared — it comes from the member components' NAMES
// (flcm.variants writes them), so it is renamed and removed by renaming and removing those. Only a
// SET can reach this: a standalone component has no axes, and a variant is refused before it.
function assertNotVariantAxis(definition: any, full: string, at: string, node: any): void {
  if (!definition || definition.type !== "VARIANT") return;
  throw new Error(
    at + ": " + JSON.stringify(bareName(full)) + " is a VARIANT axis, and a set's axes ARE its member components' names — " +
      "there is no definition to change. Rename the members of " + describeNodeIdentity(node) +
      ' (flcm.edit(variantId, { name: "Size=Huge, State=Default" })) to change the axis, or remove the variants you don\'t want.',
  );
}

// A name the component doesn't have yet: create's own definition rules, minus the slot (below). Its
// default is settled later, from the layers the same batch binds to it.
function planAddedDefinition(name: string, entry: ComponentPropertyDefinitionEdit, at: string): AddedDefinition {
  const definition = compilePropertyDefinition(name, entry, at);
  // A slot IS a frame in the definition, and this call has no frame in it. Declaring one here would
  // leave Figma's own unpositioned 100×100 box in the component — the same refusal flcm.component
  // makes for a slot nothing binds, reached from the other side.
  if (definition.figmaType === "SLOT") {
    throw new Error(
      at + ": a slot IS the frame that holds its placeholder content, so it can't be declared on its own. " +
        'Insert the frame and declare it in one move: flcm.append(component, { type: "FRAME", componentPropertyReferences: { slot: ' + JSON.stringify(name) + " } }).",
    );
  }
  // Its default is settled in the gate from this call's binders (planComponentDefinitionEdit).
  return { name, type: definition.type, figmaType: definition.figmaType };
}

// A name the component HAS: `name` renames it, and `type` may only restate what it already is — so
// a read's own `{ type }` written back is a no-op, not a refusal. Returns the new name, or undefined
// for an entry that changes nothing.
function planChangedDefinition(
  full: string, definition: any, entry: ComponentPropertyDefinitionEdit, at: string, node: any,
): string | undefined {
  if (definition.type === "VARIANT" && entry.name == null && restatesVariantAxis(definition, entry)) return undefined;
  assertNotVariantAxis(definition, full, at, node);
  if (entry.variantOptions != null) {
    throw new Error(at + ": `variantOptions` belongs to a set's variant axis, and " + JSON.stringify(bareName(full)) + " is " + JSON.stringify(PROPERTY_TYPE_WORD_FOR[definition.type] || definition.type) + ".");
  }
  if (entry.type != null) {
    const figmaType = typeof entry.type === "string" ? own(PROPERTY_TYPES, entry.type) : undefined;
    if (!figmaType) {
      throw new Error(at + ".type must be one of " + quoted(Object.keys(PROPERTY_TYPES)) + " — got " + JSON.stringify(entry.type) + ".");
    }
    if (figmaType !== definition.type) {
      throw new Error(
        at + ": " + JSON.stringify(bareName(full)) + " is " + JSON.stringify(PROPERTY_TYPE_WORD_FOR[definition.type] || definition.type) +
          " and Figma can't change a property's type. Delete it in one call ({ " + JSON.stringify(bareName(full)) + ": null }), then " +
          bindInSameBatch(bareName(full), entry.type),
      );
    }
  }
  if (entry.name != null) {
    if (typeof entry.name !== "string" || !entry.name.trim()) {
      throw new Error(at + ".name is the property's new name — a non-empty string. Got " + JSON.stringify(entry.name) + ".");
    }
    const rename = entry.name.trim();
    if (rename !== bareName(full)) return rename;
    return undefined;
  }
  if (entry.type == null) {
    throw new Error(at + ": names nothing — a definition edit passes `name` (renames it) or null (deletes it). Its default is its bound layer's content: edit that layer to change it.");
  }
  return undefined;
}

// A set's axis written back exactly as a read reports it — `{ type: "variant", variantOptions }` —
// changes nothing, so a read round-trips through edit. Any difference falls through to the axis
// refusal, which says how an axis actually changes.
function restatesVariantAxis(definition: any, entry: ComponentPropertyDefinitionEdit): boolean {
  if (entry.type != null && entry.type !== "variant") return false;
  const options = entry.variantOptions;
  if (options == null) return true;
  const live: readonly string[] = definition.variantOptions || [];
  return Array.isArray(options) && options.length === live.length && options.every((option, i) => option === live[i]);
}

/**
 * The definition writes — FIRST in the node's sealed span, so a rename and whatever else the same
 * delta says are one undo step. Deletes before renames before adds: that is the order the bag reads
 * in, and the only order under which freeing a name and re-declaring it can both land.
 */
export function applyComponentDefinitionEdit(fail: EditPlanFailure, node: any, plan: ComponentDefinitionEditPlan): MintedPropertyNames {
  try {
    if (plan.description !== undefined) node.description = plan.description;
    for (const full of plan.deletes) node.deleteComponentProperty(full);
    for (const change of plan.renames) {
      // A rename RE-SUFFIXES, and the new full name is only knowable from the return value. Whether
      // Figma re-points the layers bound to it is an ASSUMPTION until the live probe runs — so the
      // re-point happens here regardless: a no-op if Figma already did it, and the difference
      // between a bound layer and one pointing at a name nothing files a property under if it
      // didn't. A stale reference is wrong pixels with no error, which this surface never allows.
      const renamed = node.editComponentProperty(change.full, { name: change.rename });
      if (typeof renamed === "string" && renamed !== change.full) repointBoundSublayers(node, change.full, renamed);
    }
    return new Map(plan.adds.map(({ add, defaultValue }) => [add, node.addComponentProperty(add.name, add.figmaType, defaultValue) as string]));
  } catch (cause) {
    throw fail(cause);
  }
}

// Every layer in the definition still pointing at the pre-rename full name, re-pointed to the new
// one. The whole owner's subtree, variants included: a set's property is one property, and each
// variant carries its own copy of the reference to it.
function repointBoundSublayers(owner: any, before: string, after: string): void {
  for (const node of subtreeOf(owner)) {
    const live: Record<string, string> = node.componentPropertyReferences || {};
    let touched = false;
    const wire: Record<string, string> = { ...live };
    for (const key of Object.keys(wire)) {
      if (wire[key] !== before) continue;
      wire[key] = after;
      touched = true;
    }
    if (touched) node.componentPropertyReferences = wire;
  }
}

// ---- `componentPropertyReferences` under edit ----

/**
 * Which wire keys to write on the node, and to what — `null` clears the key (unbinds the field), and
 * `add` is a property this same batch adds, whose suffixed name exists only once it has applied.
 */
export interface ComponentBindingEditPlan {
  writes: { field: string; wire: string; full: string | null; add?: AddedDefinition }[];
  /** The definition owner the writes resolve against — whose added properties a binder can name. */
  owner: any;
}

/**
 * `addsOf(owner)` is the properties this same batch adds to `owner` (editMany only): a binding naming
 * one of those binds to it, and becomes one of the layers its default is read off.
 */
export function prepareComponentBindingEdit(
  node: any, raw: unknown, subject: string, addsOf?: (owner: any) => ReadonlyMap<string, AddedDefinition> | undefined,
): ComponentBindingEditPlan {
  const where = subject + ".componentPropertyReferences";
  // Asked first only for its sentence: editableComponentOwnerOf already answers null under an instance.
  const host = instanceAncestorOf(node);
  if (host) {
    throw new Error(
      where + ": " + describeNodeIdentity(node) + " is inside component instance " + JSON.stringify(host.name) + " (id " + JSON.stringify(host.id) +
        "). A binding belongs to the DEFINITION — every instance gets it from there — so bind the same layer in the main component instead (flcm never auto-detaches).",
    );
  }
  const component = editableComponentOwnerOf(node, false);
  if (!component) {
    throw new Error(
      where + ": " + describeNodeIdentity(node) + " is not inside a component, so no component declares a property for this to point at. " +
        "Make one first (flcm.component(target, { propertyDefinitions: … })), or bind a layer that is already inside one.",
    );
  }
  const owner = definitionOwnerOf(component);
  const definitions = propertyDefinitionsOf(owner);
  const refs = compileBindingEditBag(raw, bindableFieldsOf(node.type), subject, "a " + node.type);
  const live: Record<string, string> = node.componentPropertyReferences || {};
  const writes: ComponentBindingEditPlan["writes"] = [];
  const adds = addsOf?.(owner);
  for (const field of Object.keys(refs)) {
    const { wire } = BINDING_FIELD_WIRE_KEYS[field];
    const authored = refs[field];
    const at = where + "." + field;
    if (authored === null) {
      const current = own(live, wire);
      if (current === undefined) {
        throw new Error(
          at + ": nothing to unbind — this node's `" + field + "` isn't driven by a component property. " +
            (Object.keys(live).length
              ? "It is driven by " + quoted(Object.keys(live).map((k) => bareName(String(live[k])))) + "."
              : "No property drives any of its fields."),
        );
      }
      // A slot with no frame is the state flcm.component refuses to create: Figma would have nowhere
      // to put an instance's slot content. Counted in THIS definition (see nodesBoundTo) — a sibling
      // variant's own frame is no help to this one. Deleting the PROPERTY frees the frame instead.
      if (field === "slot" && nodesBoundTo(component, wire, current).length < 2) {
        throw new Error(
          at + ": this is the only frame in " + describeNodeIdentity(component) + " bound to slot property " + JSON.stringify(bareName(current)) +
            ", and a slot property with no frame has nowhere to put an instance's content. Delete the property instead — it frees this frame in the same move: " +
            "flcm.edit(" + JSON.stringify(owner.id) + ", { propertyDefinitions: { " + JSON.stringify(bareName(current)) + ": null } }).",
        );
      }
      writes.push({ field, wire, full: null });
      continue;
    }
    // The add wins over a live match: a name is only ever added when nothing the batch leaves
    // standing answers to it, so a live match here is a property the same bag deletes.
    const add = adds?.get(authored);
    if (add) {
      assertBindingFieldMatchesType(field, add.figmaType, authored, at);
      writes.push({ field, wire, full: null, add });
      continue;
    }
    writes.push({ field, wire, full: resolveBindingToDefinition(definitions, component, field, authored, at, node) });
  }
  return { writes, owner };
}

function assertBindingFieldMatchesType(field: string, figmaType: string, name: string, at: string): void {
  const { type } = BINDING_FIELD_WIRE_KEYS[field];
  if (figmaType === PROPERTY_TYPES[type]) return;
  throw new Error(
    at + ": `" + field + "` is driven by a " + type + " property, and " + JSON.stringify(bareName(name)) +
      " is " + JSON.stringify(PROPERTY_TYPE_WORD_FOR[figmaType] || figmaType) + ".",
  );
}

/**
 * The last step of every binding, wherever it is authored: the name Figma files the property under,
 * type-checked against the field that will drive it, and — for a slot — checked to be the one hole a
 * slot is. Both paths into a binding (an edit of a live layer, a compiled node inserted into a component)
 * come through here, so a field added to BINDING_FIELD_WIRE_KEYS is reasoned about once.
 *
 * `definitions` are read off the definition OWNER (the SET, for a variant) because that is where
 * Figma keeps them; `scope` is the subtree the slot rule COUNTS in, which is the variant, not the
 * set. `exclude` is the node whose own binding doesn't count against it — an edit re-stating the
 * slot it already holds.
 */
function resolveBindingToDefinition(
  definitions: Record<string, any>, scope: any, field: string, authored: string, at: string, exclude: any,
): string {
  const { wire, type } = BINDING_FIELD_WIRE_KEYS[field];
  const full = resolvePropertyName(authored, definitions, at);
  assertBindingFieldMatchesType(field, definitions[full].type, full, at);
  // A slot is one hole: two frames bound to it would give an instance's content two places to land.
  if (field === "slot") {
    const taken = nodesBoundTo(scope, wire, full).filter((n) => n !== exclude);
    if (taken.length) {
      throw new Error(
        at + ": slot property " + JSON.stringify(bareName(full)) + " already has its frame " + describeNodeIdentity(taken[0]) +
          ", and a slot is one hole. Unbind that one first, or bind a different property.",
      );
    }
  }
  return full;
}

// Every node bound to `full` through `wire`, in ONE definition's subtree — root included. The scope
// is a definition, not the property's owner, because a set's variants each carry their own copy of a
// binding: one slot property on a set is realized by one frame in EACH variant, so "a slot is one
// hole" is a per-variant count. Name resolution stays on the owner; only this count is scoped down.
function nodesBoundTo(definition: any, wire: string, full: string): any[] {
  return definitionLayersOf(definition).filter((n) => own((n.componentPropertyReferences || {}) as Record<string, string>, wire) === full);
}

// A definition's own layers, root included. A nested instance is one of them, but its sublayers are
// its own component's copies — they may carry this owner's full names (an instance of a sibling
// variant) without being bound in this definition.
function definitionLayersOf(root: any): any[] {
  const out = [root];
  if (root.type !== "INSTANCE") for (const child of root.children || []) out.push(...definitionLayersOf(child));
  return out;
}

function subtreeOf(root: any): any[] {
  return [root, ...root.findAll(() => true)];
}

/**
 * The binding writes — AFTER the node's own words in the same sealed span, so the layer is what this
 * delta makes it before it is wired to a property. Merged onto the live bag, never replacing it: a
 * delta naming `text` leaves a `visible` binding alone, the way every other edit word behaves.
 */
export function applyComponentBindingEdit(fail: EditPlanFailure, node: any, plan: ComponentBindingEditPlan, minted: MintedPropertyNames): void {
  try {
    const wire: Record<string, string> = { ...(node.componentPropertyReferences || {}) };
    for (const write of plan.writes) {
      if (write.add) wire[write.wire] = mintedNameOf(minted, write.add);
      else if (write.full === null) delete wire[write.wire];
      else wire[write.wire] = write.full;
    }
    node.componentPropertyReferences = wire;
  } catch (cause) {
    throw fail(cause);
  }
}

// An add's binders are planned only in the batch that adds it, and the stages land every definition
// before any binding — so a miss is a stage-order bug, refused before it writes an unbound reference.
function mintedNameOf(minted: MintedPropertyNames, add: AddedDefinition): string {
  const name = minted.get(add);
  if (name === undefined) throw new Error("flcm internal: " + JSON.stringify(add.name) + " was bound before it was added.");
  return name;
}

// ---- an EXISTING property's default, settled from its binders ----
//
// Binding a layer writes the property's default into it, so the default and every layer bound to it
// are one value. A call that binds to a property the component already has settles that value the way
// a new property's is settled: from every layer bound to it once the call lands — the ones it binds
// and the ones already bound. They must agree; when the call's binders are the only ones, the default
// takes their content BEFORE the bindings land, so binding writes back what the layer already shows.

/** One field a call binds to a property the component already has. */
export interface ExistingPropertyBinding {
  owner: any;
  /** The property's full (suffixed) name. */
  full: string;
  wire: string;
  binder: PropertyBinder;
  /** Where a refusal about this binding is reported. */
  at: string;
}

/** What the call does to the layers ALREADY bound to the properties it binds. */
interface StandingBinderFacts {
  /** True when this call rewrites `wire` on `node` (rebinds or unbinds it) or removes the node — its standing binding stops counting. */
  leaves(node: any, wire: string): boolean;
  /** What `node` will show for `field` if this call changes it; undefined when it doesn't. */
  shows(node: any, field: string): boolean | string | undefined;
}

/** A default an existing property takes before the call's bindings land. */
interface BoundDefaultWrite {
  owner: any;
  full: string;
  value: boolean | string;
  /** The binding the write is settled for — whose entry an applier failure names. */
  by: ExistingPropertyBinding;
}

/**
 * THE one place a binding to an existing property is judged, for every path that binds one (edit,
 * editMany, and a bound insert). A slot holds no value, so it never reaches here. `refuse` receives
 * the property's first binding and the refusal; it rethrows unless the caller collects per entry.
 */
export function settleExistingPropertyDefaults(
  bindings: readonly ExistingPropertyBinding[], standing: StandingBinderFacts,
  refuse: (binding: ExistingPropertyBinding, cause: unknown) => void = (_, cause) => { throw cause; },
): BoundDefaultWrite[] {
  const groups = new Map<any, Map<string, ExistingPropertyBinding[]>>();
  for (const binding of bindings) {
    const byName = groups.get(binding.owner) ?? new Map<string, ExistingPropertyBinding[]>();
    groups.set(binding.owner, byName);
    byName.set(binding.full, [...(byName.get(binding.full) ?? []), binding]);
  }
  const writes: BoundDefaultWrite[] = [];
  for (const [owner, byName] of groups) {
    const definitions = propertyDefinitionsOf(owner);
    for (const [full, group] of byName) {
      const definition = definitions[full];
      const type = PROPERTY_TYPE_WORD_FOR[definition.type];
      const field = FIELD_FOR_TYPE[type];
      // Every variant's bound layers count: a set's property has one default, shown in each of them.
      // A layer the call leaves alone shows that default, because Figma keeps the two equal. Not
      // modelled: an edit to ONE bound layer carrying its siblings along, so a batch editing one of
      // two bound layers and binding a third to match is refused; edit first, then bind.
      const already = definitionLayersOf(owner)
        .filter((node) => own((node.componentPropertyReferences || {}) as Record<string, string>, group[0].wire) === full && !standing.leaves(node, group[0].wire))
        .map((node) => ({ layer: JSON.stringify(node.name) + " (already bound)", value: standing.shows(node, field) ?? definition.defaultValue }));
      try {
        const value = agreedDefault({ name: bareName(full), type }, [...already, ...group.map((b) => b.binder)], group[0].at, { inherited: definition.defaultValue });
        if (value !== definition.defaultValue) writes.push({ owner, full, value, by: group[0] });
      } catch (cause) {
        refuse(group[0], cause);
      }
    }
  }
  return writes;
}

/**
 * Detach every value field a call is about to rebind or unbind on `node`, before ANY of the call's
 * writes land. While still bound, a write to that field (an edit, a swap) would land on the old
 * property's default and every layer bound to it, and a settled default write would rewrite the node
 * — a swap and back loses its overrides. A slot is left: it holds no value, and its frame would stop being one.
 */
export function releaseRewiredBindings(node: any, wires: readonly string[]): void {
  const live: Record<string, string> = node.componentPropertyReferences || {};
  const released = wires.filter((wire) => wire !== BINDING_FIELD_WIRE_KEYS.slot.wire && own(live, wire) !== undefined);
  if (!released.length) return;
  const wire: Record<string, string> = { ...live };
  for (const key of released) delete wire[key];
  node.componentPropertyReferences = wire;
}

/** releaseRewiredBindings for a planned binding edit, in a sealed span's failure terms. */
export function applyBindingRelease(fail: EditPlanFailure, node: any, plan: ComponentBindingEditPlan): void {
  try {
    releaseRewiredBindings(node, plan.writes.map((write) => write.wire));
  } catch (cause) {
    throw fail(cause);
  }
}

/** The settled defaults — after the layers' own words, before ANY binding of the call lands. */
export function applyBoundDefaults(fail: EditPlanFailure, writes: readonly BoundDefaultWrite[]): void {
  try {
    for (const write of writes) write.owner.editComponentProperty(write.full, { defaultValue: write.value });
  } catch (cause) {
    throw fail(cause);
  }
}

/** The existing-property bindings in one planned binding edit, each binder's value read by `value`. */
export function existingPropertyBindings(
  binding: ComponentBindingEditPlan, layer: string, at: string, value: (field: string) => boolean | string,
): ExistingPropertyBinding[] {
  return binding.writes.flatMap((write) => write.full === null || write.field === "slot"
    ? []
    : [{ owner: binding.owner, full: write.full, wire: write.wire, binder: { layer, value: value(write.field) }, at: at + ".componentPropertyReferences." + write.field }]);
}

/** What a layer an edit targets will show for a binding field because of that edit — undefined if the edit doesn't touch it. */
export function editedBinderValue(field: string, plan: EditPlan | undefined, instance: InstanceEditPlan | undefined): boolean | string | undefined {
  if (!plan) return undefined;
  if (field === "visible") return plan.patch.visible;
  if (field === "text") return plan.patch.runs ? textOfRuns(plan.patch.runs) : plan.patch.text;
  return instance && instance.retargets ? instance.becomes.id : undefined;
}

// What a bound live layer will show once its edit (if any) has landed: the edit's own word for the
// field if it names one, else the live value. That is the value a binding would write back into it,
// so it is the value the property's default must hold. `main` is the live instance's component, for a swap binder.
export function projectedBinderValue(field: string, node: any, plan: EditPlan | undefined, instance: InstanceEditPlan | undefined, main: any | null, at: string): boolean | string {
  const edited = editedBinderValue(field, plan, instance);
  if (edited !== undefined) return edited;
  if (field === "visible") return node.visible !== false;
  if (field === "text") return node.characters;
  return readableComponentOf(main, node, at).id;
}

// ---- both halves, as one delta's component work ----

/** An edit delta's COMPONENT half, resolved. Any part may be absent. */
export interface ComponentEditPlan {
  definitions?: ComponentDefinitionEditPlan;
  binding?: ComponentBindingEditPlan;
  /** Applied in their own pass between the layers' words and the bindings (applyBoundDefaults). */
  defaults?: BoundDefaultWrite[];
}

/**
 * The sync half, run in the verb's gate: every definition and binding word, decided against the live
 * component. One delta can't both add a property and bind a sublayer to it, so a property it adds has
 * no binder — refused, pointing at editMany (which plans the halves across entries itself).
 * `binderValue` is what the node will show for a bound field once this delta lands.
 */
export function planComponentEdit(
  node: any, words: ComponentEditWords, subject: string, binderValue: (field: string) => boolean | string,
): ComponentEditPlan {
  const plan: ComponentEditPlan = {};
  if (words.description !== undefined || words.propertyDefinitions !== undefined) {
    plan.definitions = planComponentDefinitionEdit(node, words, subject, planAddedDefinitions(node, words, subject), () => []);
  }
  if (words.componentPropertyReferences !== undefined) {
    const binding = prepareComponentBindingEdit(node, words.componentPropertyReferences, subject);
    plan.binding = binding;
    plan.defaults = settleExistingPropertyDefaults(existingPropertyBindings(binding, describeBinder(node.name, subject), subject, binderValue), {
      leaves: (other, wire) => other === node && binding.writes.some((write) => write.wire === wire),
      shows: () => undefined,
    });
  }
  return plan;
}

// ---- a bound authored node inserted into an existing component ----

/**
 * What an insert has to do about the bindings its tree carries, resolved against the component it
 * is landing in. `resolved` maps each AUTHORED property name to the full name Figma files it under;
 * `declaresSlots` are the slot properties this insert MINTS, which is the one thing an insert can
 * declare — a slot IS its frame, so after the component exists there is no other way to make one.
 */
export interface InsertBindingPlan {
  owner: any;
  resolved: Record<string, string>;
  declaresSlots: string[];
  defaults: BoundDefaultWrite[];
}

/**
 * Prepare the bindings of a tree being inserted into `parent`. Returns undefined when it
 * carries none — the ordinary insert, unchanged. A tree that DOES carry them and is landing
 * anywhere but inside a component is refused by flcm's own surface-wide rule (a binding with no
 * declaring component names nothing). `removes` is a live node the verb takes off the canvas
 * (replace's original), so a binding it holds stops counting.
 *
 * Synchronous by type, and that is load-bearing: every fact it reads is live, so it runs in the
 * insert verb's synchronous gate — see structure.ts.
 */
export function prepareInsertBindings(
  subject: string, parent: any, tree: WriteNode, resources: RenderResources, removes: (node: any) => boolean = () => false,
): InsertBindingPlan | undefined {
  const bound: { wn: WriteNode; refs: ComponentPropertyBinding }[] = [];
  collectTreeBindings(tree, resources.live, bound);
  if (!bound.length) return undefined;
  // A COMPONENT_SET destination is refused before this runs (structure.ts's assertBuiltInsertNotIntoSet),
  // so `component` is a standalone component or a set's VARIANT — the definition the slot rule counts in.
  // A tree landing in an instance's SLOT has no editable owner even under a component: instance
  // content binds nothing.
  const component = editableComponentOwnerOf(parent, true);
  // Not landing in a component: the standing refusal, in its own words.
  if (!component) assertNoComponentPropertyBindings(tree, subject);
  const owner = definitionOwnerOf(component);
  const definitions = propertyDefinitionsOf(owner);
  const plan: InsertBindingPlan = { owner, resolved: {}, declaresSlots: [], defaults: [] };
  const existing: ExistingPropertyBinding[] = [];
  const binderNodes: { wn: WriteNode; full: string }[] = [];
  const where = subject + ".componentPropertyReferences";
  // A slot is one hole, and the second claim on it can come from this same tree — where neither
  // frame is on the canvas yet for the live count to see. Declared names and full names never
  // collide (a full name carries Figma's #suffix), so one list holds both.
  const claimedSlots: string[] = [];
  const claimSlot = (name: string, at: string): void => {
    if (claimedSlots.indexOf(name) !== -1) {
      throw new Error(at + ": two frames in this tree claim slot " + JSON.stringify(bareName(name)) + ", and a slot is one hole. Bind the one the content goes into.");
    }
    claimedSlots.push(name);
  };
  for (const { wn, refs } of bound) {
    for (const field of Object.keys(refs)) {
      const authored = (refs as Record<string, string>)[field];
      const at = where + "." + field;
      if (!matchPropertyNames(authored, definitions).length && field === "slot") {
        // The one DECLARING insert. Everywhere else a binding names a property that must already
        // exist; a slot has no other birth, because the frame being inserted IS the slot.
        //
        // Into a VARIANT this declares a property on the SET that only this variant realizes, and
        // that is deliberate: it is the only way to START a set's slot, and the sibling variants are
        // completed by inserting their own bound frame (which the per-variant slot count allows).
        claimSlot(authored, at);
        plan.declaresSlots.push(authored);
        continue;
      }
      const full = resolveBindingToDefinition(definitions, component, field, authored, at, undefined);
      plan.resolved[authored] = full;
      if (field === "slot") {
        claimSlot(full, at);
        continue;
      }
      const layer = describeBinder(wn.liveId === undefined ? wn.name : resources.live.get(wn)!.node.name, wn.sourcePath!);
      existing.push({ owner, full, wire: BINDING_FIELD_WIRE_KEYS[field].wire, binder: { layer, value: boundLayerValue(definitions[full].type, wn, resources.instances, resources.live) }, at });
      binderNodes.push({ wn, full });
    }
  }
  // A live node in the tree is what it is once its own words land (LiveTreeNode.shows), and one
  // that carries a binding on a field rebinds that field.
  const liveRefs = new Map<any, LiveRef>();
  for (const [ref, liveNode] of resources.live) liveRefs.set(liveNode.node, ref);
  plan.defaults = settleExistingPropertyDefaults(existing, {
    leaves: (node, wire) => {
      const ref = liveRefs.get(node);
      const refs = (ref ? resources.live.get(ref)!.refs ?? {} : {}) as Record<string, string>;
      return removes(node) || Object.keys(refs).some((field) => BINDING_FIELD_WIRE_KEYS[field].wire === wire);
    },
    shows: (node, field) => {
      const ref = liveRefs.get(node);
      return ref ? boundLayerValue(PROPERTY_TYPES[BINDING_FIELD_WIRE_KEYS[field].type], ref, resources.instances, resources.live) : undefined;
    },
  });
  for (const { wn, full } of binderNodes) {
    const settled = plan.defaults.find((write) => write.full === full);
    writeInheritedDefault(definitions[full].type, wn, settled ? settled.value : definitions[full].defaultValue);
  }
  return plan;
}

// Every bound node in the tree, ROOT INCLUDED — unlike flcm.component's collectChildBindings, where the root
// becomes the component and can't point at a property of itself. Here the root is an ordinary child
// of the component it lands in, so binding it is exactly as meaningful as binding any other layer.
function collectTreeBindings(wn: WriteNode, live: LiveBindings, out: { wn: WriteNode; refs: ComponentPropertyBinding }[]): void {
  const refs = bindingsOf(wn, live);
  if (refs) out.push({ wn, refs });
  for (const child of wn.children ?? []) collectTreeBindings(child, live, out);
}

/**
 * Settle the existing properties' defaults, mint the slot properties this insert declares, then
 * write every binding onto the built nodes — inside the insert's own sealed span, after the tree is
 * attached and settled.
 */
export function applyInsertBindings(plan: InsertBindingPlan, built: readonly BoundLiveNode[]): void {
  for (const write of plan.defaults) write.owner.editComponentProperty(write.full, { defaultValue: write.value });
  const suffixed: Record<string, string> = { ...plan.resolved };
  // Declaring a slot may make Figma materialize its own unpositioned 100×100 placeholder for the
  // hole — it does when a slot is declared through the UI, and whether this API call does it too is
  // an ASSUMPTION until the live probe runs. The frame this insert is binding IS the hole, so a
  // placeholder beside it would be wrong pixels with no error: mint through declareSlotProperty,
  // which sweeps whatever the call left behind.
  for (const name of plan.declaresSlots) suffixed[name] = declareSlotProperty(plan.owner, name);
  writeBindingReferences(built, suffixed);
}

// Mint one slot property on the definition owner and take its suffixed name back, leaving the
// document with no node it didn't have. Nothing else can add a node during a sealed span, so a node
// that appears across the call — and whose parent was already there — is Figma's own placeholder.
function declareSlotProperty(owner: any, name: string): string {
  const before = new Set(subtreeOf(owner));
  // "" is the value Figma stores for a slot: its content is the bound frame, never a value.
  const full: string = owner.addComponentProperty(name, "SLOT", "");
  for (const node of subtreeOf(owner)) {
    if (!before.has(node) && before.has(node.parent)) node.remove();
  }
  return full;
}
