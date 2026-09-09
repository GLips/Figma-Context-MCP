// component-edit — editing the DEFINITION side of a component, which is how every instance of it
// changes at once. There is no verb here: a main component is edited with `flcm.edit` /
// `flcm.editMany` and its sublayers with the structural verbs, exactly as any frame is, and Figma
// carries the change into every instance because that is what a component IS. This module is the
// three things those verbs can't judge without the live document:
//
//   • `propertyDefinitions` under edit — ADD a property (a name the component doesn't have),
//     CHANGE one (`defaultValue`, or `name` to rename), or DELETE one (`null`).
//   • `componentPropertyReferences` under edit — bind an existing sublayer to a property, or
//     unbind it (`null` per field).
//   • the bindings a SPEC carries into an existing component through append/prepend/insertBefore/
//     insertAfter — the one place outside flcm.component where a binding means something.
//
// The split is edit's own (see edit-plan.ts): the sync compile judges the words' SHAPE, the targets
// the words name resolve in the verb's prepare (resolveComponentEditTargets), everything that reads
// the definitions is decided in the verb's synchronous GATE (planComponentEdit) with zero writes,
// and the apply is a sync span the verb seals — a rename and a recolor of the same component are
// one undo step.
//
// Where the writes sit in that span is a rule, not an accident: definitions land BEFORE the node's
// own words (a rename must be part of the same step as whatever else the delta says), bindings land
// AFTER them (the node has to be what this delta makes it before it is wired to a property).

import { WriteNode, WriteChild, ComponentEditWords, ComponentPropertyBinding, ComponentPropertyDefinitionEdit, Target } from "./ir.js";
import { BoundSpecNode } from "./bridge.js";
import { EditPlanFailure } from "./edit-plan.js";
import {
  PROPERTY_TYPES, PROPERTY_TYPE_WORD_FOR, BINDING_FIELD_WIRE_KEYS, FIELD_FOR_TYPE, PreparedDefinition,
  compilePropertyDefinition, componentAncestorOf, writeBindingReferences, quoted,
} from "./component.js";
import { resolveComponentNode, resolvePropertyName, matchPropertyNames, bareName } from "./instance.js";
import { ResolvedTargets } from "./read.js";
import { compileBindingEditBag, bindingFieldsForType, assertNoComponentPropertyBindings } from "./flcm.js";
import { instanceAncestorOf, describeNodeIdentity, definitionOwnerOf, propertyDefinitionsOf } from "./identity.js";
import { own } from "./validate.js";

// ---- `propertyDefinitions` under edit ----

/**
 * What an edit does to a component's declarations, fully resolved: every name matched to the full
 * name Figma files it under, every default type-checked, every instance-swap target already a node
 * id. Applied in this order — deletes, then renames/changes, then adds — so a delta that frees a
 * name and re-declares it lands the way it reads.
 */
export interface ComponentDefinitionEditPlan {
  description?: string;
  /** Full (suffixed) names to delete. */
  deletes: string[];
  changes: { full: string; rename?: string; defaultValue?: boolean | string }[];
  adds: PreparedDefinition[];
}

function planComponentDefinitionEdit(
  node: any, words: ComponentEditWords, targets: ResolvedTargets, subject: string,
): ComponentDefinitionEditPlan {
  const plan: ComponentDefinitionEditPlan = { deletes: [], changes: [], adds: [] };
  if (words.description !== undefined) plan.description = words.description;
  const authored = words.propertyDefinitions;
  if (!authored) return plan;
  const where = subject + ".propertyDefinitions";
  // A variant's properties belong to its SET (Figma stores them there, and reading them off the
  // variant throws), so an edit aimed at the variant would be aimed at the wrong node — including
  // for the agent's mental model, since the change reaches every variant either way.
  if (node.type === "COMPONENT" && node.parent && node.parent.type === "COMPONENT_SET") {
    throw new Error(
      where + ": " + describeNodeIdentity(node) + " is a VARIANT, and a set's properties live on the SET — Figma keeps them there, and a change reaches every variant. " +
        "Edit the set instead: flcm.edit(" + JSON.stringify(node.parent.id) + ", { propertyDefinitions: … }).",
    );
  }
  const definitions = propertyDefinitionsOf(node);
  // Every name this call will have made by the time it lands — what a rename must not collide with.
  // Deletes are accounted FIRST, in their own pass, because that is the order they apply in: a bag
  // that renames onto a name it also deletes is legal however the agent ordered its keys.
  const taken = new Set(Object.keys(definitions).map(bareName));
  const names = Object.keys(authored);
  for (const name of names) {
    if (authored[name] !== null) continue;
    const at = where + "[" + JSON.stringify(name) + "]";
    const full = resolvePropertyName(name, definitions, where);
    assertNotVariantAxis(definitions[full], full, at, node);
    plan.deletes.push(full);
    taken.delete(bareName(full));
  }
  for (const name of names) {
    const entry = authored[name];
    if (entry === null) continue;
    const at = where + "[" + JSON.stringify(name) + "]";
    const matches = matchPropertyNames(name, definitions);
    if (!matches.length) {
      plan.adds.push(planAddedDefinition(name, entry, at, targets));
      taken.add(name);
      continue;
    }
    const full = resolvePropertyName(name, definitions, where);
    const change = planChangedDefinition(full, definitions[full], entry, at, node, taken, targets);
    if (change.rename !== undefined) {
      taken.delete(bareName(full));
      taken.add(change.rename);
    }
    plan.changes.push(change);
  }
  return plan;
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

// A name the component doesn't have yet: create's own definition rules, with two differences that
// both come from there being no spec in this call.
function planAddedDefinition(name: string, entry: ComponentPropertyDefinitionEdit, at: string, targets: ResolvedTargets): PreparedDefinition {
  const definition = compilePropertyDefinition(name, entry, at);
  // A slot IS a frame in the definition, and this call has no frame in it. Declaring one here would
  // leave Figma's own unpositioned 100×100 box in the component — the same refusal flcm.component
  // makes for a slot nothing binds, reached from the other side.
  if (definition.figmaType === "SLOT") {
    throw new Error(
      at + ": a slot IS the frame that holds its placeholder content, so it can't be declared on its own. " +
        'Insert the frame and declare it in one move: flcm.append(component, flcm.frame({ …, componentPropertyReferences: { slot: ' + JSON.stringify(name) + " } })).",
    );
  }
  // At create the default is DERIVED from the node that binds the property. Nothing binds this one —
  // an edit declares a property and nothing else — so there is no node to read a starting value off.
  if (definition.defaultValue === undefined) {
    throw new Error(
      at + ": a property added by an edit needs a `defaultValue` — nothing in this call binds it, so there is no node to read the starting value off (flcm.component derives it from the node it binds). " +
        "Pass one, then wire a layer to it: flcm.edit(sublayer, { componentPropertyReferences: { " + FIELD_FOR_TYPE[definition.type] + ": " + JSON.stringify(name) + " } }).",
    );
  }
  const value = definition.figmaType === "INSTANCE_SWAP"
    ? resolveComponentNode(targets.node(definition.defaultValue as Target, at), at).base.id
    : (definition.defaultValue as boolean | string);
  return { name, figmaType: definition.figmaType, defaultValue: value };
}

// A name the component HAS: `defaultValue` re-defaults it, `name` renames it, and `type` may only
// restate what it already is.
function planChangedDefinition(
  full: string, definition: any, entry: ComponentPropertyDefinitionEdit, at: string, node: any, taken: ReadonlySet<string>, targets: ResolvedTargets,
): { full: string; rename?: string; defaultValue?: boolean | string } {
  assertNotVariantAxis(definition, full, at, node);
  const change: { full: string; rename?: string; defaultValue?: boolean | string } = { full };
  if (entry.type != null) {
    const figmaType = typeof entry.type === "string" ? own(PROPERTY_TYPES, entry.type) : undefined;
    if (!figmaType) {
      throw new Error(at + ".type must be one of " + quoted(Object.keys(PROPERTY_TYPES)) + " — got " + JSON.stringify(entry.type) + ".");
    }
    if (figmaType !== definition.type) {
      throw new Error(
        at + ": " + JSON.stringify(bareName(full)) + " is " + JSON.stringify(PROPERTY_TYPE_WORD_FOR[definition.type] || definition.type) +
          " and Figma can't change a property's type. Delete it and declare the new one: { " + JSON.stringify(bareName(full)) + ": null, " +
          JSON.stringify(bareName(full)) + ": { type: " + JSON.stringify(entry.type) + ", defaultValue: … } } in two calls, since one object can't carry the key twice.",
      );
    }
  }
  if (entry.name != null) {
    if (typeof entry.name !== "string" || !entry.name.trim()) {
      throw new Error(at + ".name is the property's new name — a non-empty string. Got " + JSON.stringify(entry.name) + ".");
    }
    const rename = entry.name.trim();
    if (rename !== bareName(full) && taken.has(rename)) {
      throw new Error(
        at + ": this component already has a property named " + JSON.stringify(rename) + ". Figma allows the duplicate (the #suffix is the identity) but flcm doesn't — every later reference names a property by name and a duplicate has no way to say which.",
      );
    }
    if (rename !== bareName(full)) change.rename = rename;
  }
  if (entry.defaultValue != null) change.defaultValue = resolveChangedDefault(definition, entry.defaultValue, at, full, targets);
  if (change.rename === undefined && change.defaultValue === undefined) {
    throw new Error(
      at + ": names nothing that can change — a definition edit passes `defaultValue` (the value fresh instances start at), `name` (renames it), or null (deletes it). `type` alone can only restate what the property already is.",
    );
  }
  return change;
}

function resolveChangedDefault(definition: any, value: unknown, at: string, full: string, targets: ResolvedTargets): boolean | string {
  const named = JSON.stringify(bareName(full));
  switch (definition.type) {
    case "SLOT":
      throw new Error(
        at + ": " + named + " is a slot, and a slot has no value — its content is the FRAME bound to it. Edit that frame, or rebind the slot with componentPropertyReferences.",
      );
    case "BOOLEAN":
      if (typeof value !== "boolean") throw new Error(at + ": " + named + " is a boolean property — its defaultValue is true or false. Got " + JSON.stringify(value) + ".");
      return value;
    case "TEXT":
      if (typeof value !== "string") throw new Error(at + ": " + named + " is a text property — its defaultValue is a string. Got " + JSON.stringify(value) + ".");
      return value;
    case "INSTANCE_SWAP":
      return resolveComponentNode(targets.node(value as Target, at), at).base.id;
    default:
      throw new Error(at + ": " + named + " is a " + String(definition.type) + " property, which flcm has no word for.");
  }
}

/**
 * The definition writes — FIRST in the node's sealed span, so a rename and whatever else the same
 * delta says are one undo step. Deletes before renames before adds: that is the order the bag reads
 * in, and the only order under which freeing a name and re-declaring it can both land.
 */
export function applyComponentDefinitionEdit(fail: EditPlanFailure, node: any, plan: ComponentDefinitionEditPlan): void {
  try {
    if (plan.description !== undefined) node.description = plan.description;
    for (const full of plan.deletes) node.deleteComponentProperty(full);
    for (const change of plan.changes) {
      const patch: { name?: string; defaultValue?: boolean | string } = {};
      if (change.rename !== undefined) patch.name = change.rename;
      if (change.defaultValue !== undefined) patch.defaultValue = change.defaultValue;
      // A rename RE-SUFFIXES, and the new full name is only knowable from the return value. Whether
      // Figma re-points the layers bound to it is an ASSUMPTION until the live probe runs — so the
      // re-point happens here regardless: a no-op if Figma already did it, and the difference
      // between a bound layer and one pointing at a name nothing files a property under if it
      // didn't. A stale reference is wrong pixels with no error, which this surface never allows.
      const renamed = node.editComponentProperty(change.full, patch);
      if (typeof renamed === "string" && renamed !== change.full) repointBoundSublayers(node, change.full, renamed);
    }
    for (const add of plan.adds) node.addComponentProperty(add.name, add.figmaType, add.defaultValue);
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

/** Which wire keys to write on the node, and to what — `null` clears the key (unbinds the field). */
export interface ComponentBindingEditPlan {
  writes: { field: string; wire: string; full: string | null }[];
}

export function prepareComponentBindingEdit(node: any, raw: unknown, subject: string): ComponentBindingEditPlan {
  const where = subject + ".componentPropertyReferences";
  // The instance check comes FIRST and is not interchangeable with the component one: a sublayer of
  // an instance that itself sits in a component has a component ancestor, and answering with THAT
  // component would resolve the name against the wrong definitions.
  const host = instanceAncestorOf(node);
  if (host) {
    throw new Error(
      where + ": " + describeNodeIdentity(node) + " is inside component instance " + JSON.stringify(host.name) + " (id " + JSON.stringify(host.id) +
        "). A binding belongs to the DEFINITION — every instance gets it from there — so bind the same layer in the main component instead (flcm never auto-detaches).",
    );
  }
  const component = componentAncestorOf(node);
  if (!component) {
    throw new Error(
      where + ": " + describeNodeIdentity(node) + " is not inside a component, so no component declares a property for this to point at. " +
        "Make one first (flcm.component(target, { propertyDefinitions: … })), or bind a layer that is already inside one.",
    );
  }
  const owner = definitionOwnerOf(component);
  const definitions = propertyDefinitionsOf(owner);
  const refs = compileBindingEditBag(raw, bindingFieldsForType(node.type), subject, "a " + node.type);
  const live: Record<string, string> = node.componentPropertyReferences || {};
  const writes: { field: string; wire: string; full: string | null }[] = [];
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
    writes.push({ field, wire, full: resolveBindingToDefinition(definitions, component, field, authored, at, node) });
  }
  return { writes };
}

/**
 * The last step of every binding, wherever it is authored: the name Figma files the property under,
 * type-checked against the field that will drive it, and — for a slot — checked to be the one hole a
 * slot is. Both paths into a binding (an edit of a live layer, a spec inserted into a component)
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
  const definition = definitions[full];
  if (definition.type !== PROPERTY_TYPES[type]) {
    throw new Error(
      at + ": `" + field + "` is driven by a " + type + " property, and " + JSON.stringify(bareName(full)) +
        " is " + JSON.stringify(PROPERTY_TYPE_WORD_FOR[definition.type] || definition.type) + ".",
    );
  }
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
  return subtreeOf(definition).filter((n) => own((n.componentPropertyReferences || {}) as Record<string, string>, wire) === full);
}

function subtreeOf(root: any): any[] {
  return [root, ...root.findAll(() => true)];
}

/**
 * The binding writes — AFTER the node's own words in the same sealed span, so the layer is what this
 * delta makes it before it is wired to a property. Merged onto the live bag, never replacing it: a
 * delta naming `text` leaves a `visible` binding alone, the way every other edit word behaves.
 */
export function applyComponentBindingEdit(fail: EditPlanFailure, node: any, plan: ComponentBindingEditPlan): void {
  try {
    const wire: Record<string, string> = { ...(node.componentPropertyReferences || {}) };
    for (const write of plan.writes) {
      if (write.full === null) delete wire[write.wire];
      else wire[write.wire] = write.full;
    }
    node.componentPropertyReferences = wire;
  } catch (cause) {
    throw fail(cause);
  }
}

// ---- both halves, as one delta's component work ----

/** An edit delta's COMPONENT half, resolved. Either side may be absent; both may not. */
export interface ComponentEditPlan {
  definitions?: ComponentDefinitionEditPlan;
  binding?: ComponentBindingEditPlan;
}

/**
 * The async half: every component target a definition edit names as an instance-swap default —
 * an ADD says its type itself, a CHANGE's type is the live definition's, read here as the document
 * stands (the gate reads it again; a default that became a swap during the loads is a miss the
 * lookup refuses).
 */
export async function resolveComponentEditTargets(node: any, words: ComponentEditWords, targets: ResolvedTargets): Promise<void> {
  const authored = words.propertyDefinitions;
  if (!authored) return;
  const definitions = node.type === "COMPONENT" || node.type === "COMPONENT_SET" ? propertyDefinitionsOf(definitionOwnerOf(node)) : {};
  for (const name of Object.keys(authored)) {
    const entry = authored[name];
    if (entry === null || entry.defaultValue == null || typeof entry.defaultValue === "boolean") continue;
    const matches = matchPropertyNames(name, definitions);
    const swaps = matches.length ? matches.length === 1 && definitions[matches[0]].type === "INSTANCE_SWAP" : entry.type === "instance_swap";
    if (swaps) await targets.resolve(entry.defaultValue as Target);
  }
}

/** The sync half, run in the verb's gate: every definition and binding word, decided against the live component. */
export function planComponentEdit(node: any, words: ComponentEditWords, targets: ResolvedTargets, subject: string): ComponentEditPlan {
  const plan: ComponentEditPlan = {};
  if (words.description !== undefined || words.propertyDefinitions !== undefined) {
    plan.definitions = planComponentDefinitionEdit(node, words, targets, subject);
  }
  if (words.componentPropertyReferences !== undefined) {
    plan.binding = prepareComponentBindingEdit(node, words.componentPropertyReferences, subject);
  }
  return plan;
}

// ---- a bound SPEC inserted into an existing component ----

/**
 * What an insert has to do about the bindings its spec carries, resolved against the component it
 * is landing in. `resolved` maps each AUTHORED property name to the full name Figma files it under;
 * `declaresSlots` are the slot properties this insert MINTS, which is the one thing an insert can
 * declare — a slot IS its frame, so after the component exists there is no other way to make one.
 */
export interface InsertBindingPlan {
  owner: any;
  resolved: Record<string, string>;
  declaresSlots: string[];
}

/**
 * Prepare the bindings of a spec being inserted into `parent`. Returns undefined when the spec
 * carries none — the ordinary insert, unchanged. A spec that DOES carry them and is landing
 * anywhere but inside a component is refused by flcm's own surface-wide rule (a binding with no
 * declaring component names nothing).
 *
 * Synchronous by type, and that is load-bearing: every fact it reads is live, so it runs in the
 * insert verb's synchronous gate — see structure.ts.
 */
export function prepareInsertBindings(subject: string, parent: any, spec: WriteNode): InsertBindingPlan | undefined {
  const bound: { wn: WriteNode; refs: ComponentPropertyBinding }[] = [];
  collectBoundSpecNodes(spec, bound);
  if (!bound.length) return undefined;
  // A COMPONENT_SET destination is refused before this runs (structure.ts's assertSpecInsertNotIntoSet),
  // so `component` is a standalone component or a set's VARIANT — the definition the slot rule counts in.
  // The instance question comes FIRST: a spec landing in an instance's SLOT can sit under a
  // component (an instance placed inside one), and a binding there would name a property the
  // instance's own definition — not the host component — declares. Instance content binds nothing.
  const component = instanceAncestorOf(parent) ? null : parent.type === "COMPONENT" ? parent : componentAncestorOf(parent);
  // Not landing in a component: the standing refusal, in its own words.
  if (!component) assertNoComponentPropertyBindings(spec, subject);
  const owner = definitionOwnerOf(component);
  const definitions = propertyDefinitionsOf(owner);
  const plan: InsertBindingPlan = { owner, resolved: {}, declaresSlots: [] };
  const where = subject + ".componentPropertyReferences";
  // A slot is one hole, and the second claim on it can come from this same spec — where neither
  // frame is on the canvas yet for the live count to see. Declared names and full names never
  // collide (a full name carries Figma's #suffix), so one list holds both.
  const claimedSlots: string[] = [];
  const claimSlot = (name: string, at: string): void => {
    if (claimedSlots.indexOf(name) !== -1) {
      throw new Error(at + ": two frames in this spec claim slot " + JSON.stringify(bareName(name)) + ", and a slot is one hole. Bind the one the content goes into.");
    }
    claimedSlots.push(name);
  };
  for (const { refs } of bound) {
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
      if (field === "slot") claimSlot(full, at);
      plan.resolved[authored] = full;
    }
  }
  return plan;
}

// Every bound node in the spec, ROOT INCLUDED — unlike flcm.component's own walk, where the root
// becomes the component and can't point at a property of itself. Here the root is an ordinary child
// of the component it lands in, so binding it is exactly as meaningful as binding any other layer.
function collectBoundSpecNodes(wn: WriteChild, out: { wn: WriteNode; refs: ComponentPropertyBinding }[]): void {
  if (!wn || typeof wn !== "object") return;
  if (wn.componentPropertyReferences) out.push({ wn, refs: wn.componentPropertyReferences });
  for (const child of wn.children || []) collectBoundSpecNodes(child, out);
}

/**
 * Mint the slot properties this insert declares, then write every binding onto the built nodes —
 * inside the insert's own sealed span, after the tree is attached and settled.
 */
export function applyInsertBindings(plan: InsertBindingPlan, built: readonly BoundSpecNode[]): void {
  const suffixed: Record<string, string> = { ...plan.resolved };
  // Declaring a slot may make Figma materialize its own unpositioned 100×100 placeholder for the
  // hole — it does when a slot is declared through the UI, and whether this API call does it too is
  // an ASSUMPTION until the live probe runs. The frame this insert is binding IS the hole, so a
  // placeholder beside it would be wrong pixels with no error: mint through declareSlotProperties,
  // which sweeps whatever the call left behind.
  for (const name of plan.declaresSlots) suffixed[name] = declareSlotProperty(plan.owner, name);
  writeBindingReferences(built, suffixed);
}

// Mint one slot property on the definition owner and take its suffixed name back, leaving the
// document with no node it didn't have. Nothing else can add a node during a sealed span, so a node
// that appears across the call — and whose parent was already there — is Figma's own placeholder.
function declareSlotProperty(owner: any, name: string): string {
  const before = subtreeOf(owner);
  // "" is the value Figma stores for a slot: its content is the bound frame, never a value.
  const full: string = owner.addComponentProperty(name, "SLOT", "");
  for (const node of subtreeOf(owner)) {
    if (before.indexOf(node) === -1 && before.indexOf(node.parent) !== -1) node.remove();
  }
  return full;
}
