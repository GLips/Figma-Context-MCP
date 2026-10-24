/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// component-properties — what a component property and a binding to one ARE, shared by the verb that
// creates a component (component.ts) and the edits that change one (component-edit.ts): the type and
// wire-key tables, a declared definition's shape, a binder's value, and the one default its binders
// must agree on. No verb lives here, so both sides can depend on it without depending on each other.

import { textOfRuns, type WriteNode, type BuiltNode, type LiveRef, type ComponentPropertyBinding } from "./ir.js";
import type { BoundLiveNode, InstancePlans, RenderResources } from "./bridge.js";
import { describeNodeIdentity, SLOT_CONTENT_WIRE_KEY } from "./identity.js";
import { own, rejectUnknownKeys } from "./validate.js";
import { realizeAtWritePoint } from "./write-point.js";
import { defaultValueHint } from "./compile-component-words.js";
import { BINDABLE_FIELDS, wordsOf, type BindableField, type WordValue } from "./vocabulary.js";

const DEFINITION_KEYS = wordsOf(["propertyDefinition"]);

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

export const quoted = (names: readonly string[]): string => names.map((n) => JSON.stringify(n)).join(", ");

// The read's lowercase property types → Figma's own enum. `variant` is deliberately absent: an axis
// is minted by combining components into a SET, never declared on one (see the refusal below).
export const PROPERTY_TYPES: Record<WordValue<"propertyType">, "BOOLEAN" | "TEXT" | "INSTANCE_SWAP" | "SLOT"> = {
  boolean: "BOOLEAN",
  text: "TEXT",
  instance_swap: "INSTANCE_SWAP",
  slot: "SLOT",
};
const PROPERTY_TYPE_WORDS = Object.keys(PROPERTY_TYPES);

// Figma's enum → the read's lowercase word, for a refusal that has only a LIVE definition to go on
// (an edit resolves against `componentPropertyDefinitions`, which speaks the enum).
export const PROPERTY_TYPE_WORD_FOR: Record<string, string> = {};
for (const word of PROPERTY_TYPE_WORDS) PROPERTY_TYPE_WORD_FOR[PROPERTY_TYPES[word as WordValue<"propertyType">]] = word;

// The key Figma actually stores each binding field under. The author writes the READ's spelling on
// both sides of the surface; only this table knows the wire keys — which is the whole reason a
// binding is authored rather than hand-written.
const BINDING_WIRE: Record<BindableField, string> = {
  visible: "visible",
  text: "characters",
  componentId: "mainComponent",
  slot: SLOT_CONTENT_WIRE_KEY,
};

// Each binding field: its wire key, and the property type it demands (vocabulary.ts BINDABLE_FIELDS).
export const BINDING_FIELD_WIRE_KEYS: Record<string, { wire: string; type: WordValue<"propertyType"> }> = Object.fromEntries(
  (Object.keys(BINDING_WIRE) as BindableField[]).map((field) => [field, { wire: BINDING_WIRE[field], type: BINDABLE_FIELDS[field].propertyType }]),
);

// Which binding field carries a property of each type — the table above inverted, for the
// derived-default lookup ("which node binds this property?"). One field per type is the invariant.
export const FIELD_FOR_TYPE: Record<string, string> = {};
for (const field of Object.keys(BINDING_FIELD_WIRE_KEYS)) FIELD_FOR_TYPE[BINDING_FIELD_WIRE_KEYS[field].type] = field;

/** One `propertyDefinitions` entry as authored: shape-checked, nothing looked up yet. */
export interface AuthoredDefinition {
  name: string;
  /** The read's lowercase word — kept as authored so refusals speak the agent's own vocabulary. */
  type: string;
  figmaType: "BOOLEAN" | "TEXT" | "INSTANCE_SWAP" | "SLOT";
}

/** The same definition with its default read off its binders, ready for one addComponentProperty call. */
export interface PreparedDefinition {
  name: string;
  figmaType: "BOOLEAN" | "TEXT" | "INSTANCE_SWAP" | "SLOT";
  defaultValue: boolean | string;
}

/**
 * One DECLARED property, shape-checked with nothing looked up. Shared by flcm.component's options
 * bag and by an edit's `propertyDefinitions` ADD branch (component-edit.ts), so what a definition IS
 * is stated once.
 */
export function compilePropertyDefinition(name: string, raw: unknown, at: string): AuthoredDefinition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(at + ' must be an object like { type: "text" } — got ' + JSON.stringify(raw) + ".");
  }
  rejectUnknownKeys(raw, DEFINITION_KEYS, at, "prop", defaultValueHint(raw));
  const bag = raw as Record<string, unknown>;
  // `name` is edit's RENAME word, and this call is DECLARING a property whose name is the key it is
  // filed under — two names for one property, with no way to say which the bindings mean.
  if (bag.name != null) {
    throw new Error(
      at + ": `name` renames an EXISTING property, and this declares a new one — the key it is filed under (" + JSON.stringify(name) + ") IS its name. " +
        "Drop `name`, or key the entry by the property you meant to rename.",
    );
  }
  const type = bag.type;
  if (type === "variant" || type === "VARIANT") {
    throw new Error(
      at + ": a variant axis is not declared on a component — the axes come from the SET. Make each variant its own component, then combine them: " +
        'flcm.variants([{ component: a, variant: { ' + JSON.stringify(name) + ': "…" } }, …], { name: "…" }).',
    );
  }
  const figmaType = typeof type === "string" ? own(PROPERTY_TYPES, type) : undefined;
  if (!figmaType) {
    throw new Error(at + ".type must be one of " + quoted(PROPERTY_TYPE_WORDS) + " — got " + JSON.stringify(type) + ".");
  }
  return { name, type: type as string, figmaType };
}

/** Where a live node's binding bag lives: compiled at load, carried through the gate. */
export type LiveBindings = ReadonlyMap<LiveRef, { refs?: ComponentPropertyBinding }>;

/** The binding bag a node carries: compiled onto a built node, compiled at load for a live one. */
export function bindingsOf(wn: WriteNode, live: LiveBindings): ComponentPropertyBinding | undefined {
  return wn.liveId === undefined ? wn.componentPropertyReferences : live.get(wn)?.refs;
}

/**
 * What a layer built with the bound field unwritten shows before any binding — the default a property
 * this call creates takes when none of its binders has content. An instance always names its
 * component, so instance_swap has no entry.
 */
export const FRESH_LAYER_SHOWS: Record<string, boolean | string> = { BOOLEAN: true, TEXT: "" };

/**
 * What one authored node states for a property of `figmaType` — the value its layer will show once
 * built — or undefined when it states none: a node this call creates with the field unwritten has no
 * content to lose, so it takes whatever default the property settles on. Shared with a bound insert
 * into an existing component (component-edit.ts).
 */
export function boundLayerValue(figmaType: string, wn: WriteNode, plans: InstancePlans, live: RenderResources["live"]): boolean | string | undefined {
  // A live node always states both — its authored edit if there is one, else what it shows now
  // (LiveTreeNode.shows) — so only a node this call creates can leave one unwritten.
  if (wn.liveId !== undefined) {
    const { shows, component, node } = live.get(wn)!;
    if (figmaType === "BOOLEAN") return shows.visible;
    if (figmaType === "TEXT") return shows.text;
    return readableComponentOf(component, node, wn.sourcePath).id;
  }
  if (figmaType === "BOOLEAN") return wn.visible;
  if (figmaType === "TEXT") return authoredTextOf(wn);
  // The bound node is an INSTANCE (the compilers allow `componentId` on nothing else), and
  // its plan already holds the component this call will actually STAMP — which is the point: when
  // the node names a SET and picks a member with `componentProperties`, re-resolving the target here
  // would land on the set's DEFAULT variant and the definition's default would disagree with the very
  // node it was derived from.
  return readableComponentOf(plans.get(wn)?.component, undefined, wn.sourcePath!).id;
}

/**
 * Give a binder that left the field unwritten the default it inherits, before it is built. Binding
 * would write it anyway, but only after the tree has settled — built with it, the layer settles at
 * the size it ends up with.
 */
export function writeInheritedDefault(figmaType: string, wn: WriteNode, value: boolean | string): void {
  // A live binder already shows a value (boundLayerValue), so it never inherits one.
  if (wn.liveId !== undefined) return;
  if (figmaType === "BOOLEAN" && wn.visible === undefined) wn.visible = value as boolean;
  if (figmaType === "TEXT" && authoredTextOf(wn) === undefined) wn.text = value as string;
}

/**
 * A bound instance's component, or a refusal naming the instance: a live one whose main sits in a
 * library the file can't reach has none to read (getMainComponentAsync answers null), so there is no
 * value to make its property's default. Shared with editMany's binders.
 */
export function readableComponentOf(component: any, node: any, at: string): any {
  if (component) return component;
  throw new Error(
    at + ": " + describeNodeIdentity(node) + " has no readable main component — it comes from a library the file can't reach right now, so there is no component to read its instance_swap default from.",
  );
}

/**
 * The one value a property's binders agree on. Shared with an edit that adds a property
 * (component-edit.ts), so both refuse the same two cases in the same words: nothing binds it (there
 * is no layer to read), and binders that disagree (whichever won, the others' content would be
 * overwritten by the binding). A binder with no value has no content to lose: it takes the others'
 * value, or `inherited` when none has one — an existing property's own default, or FRESH_LAYER_SHOWS.
 */
export function agreedDefault(
  definition: { name: string; type: string }, binders: readonly { layer: string; value: boolean | string | undefined }[], at: string,
  { inherited, unboundRemedy = "bind the layer that shows it: componentPropertyReferences: { " + FIELD_FOR_TYPE[definition.type] + ": " + JSON.stringify(definition.name) + " }." }:
    { inherited: boolean | string; unboundRemedy?: string },
): boolean | string {
  if (!binders.length) {
    throw new Error(at + ": nothing in this call binds " + JSON.stringify(definition.name) + ". A property's default IS its bound layer's content, so " + unboundRemedy);
  }
  const stated = binders.filter((b) => b.value !== undefined);
  if (!stated.length) return inherited;
  const first = stated[0].value!;
  if (stated.every((b) => b.value === first)) return first;
  throw new Error(
    at + ": " + stated.length + " layers bind " + JSON.stringify(definition.name) + " and show different " + FIELD_FOR_TYPE[definition.type] + " — " +
      stated.map((b) => b.layer + " is " + JSON.stringify(b.value)).join(", ") +
      ". Binding writes the property's one default into every one of them, so make them agree in this call (set the same " + FIELD_FOR_TYPE[definition.type] + " on each), or bind just one.",
  );
}

/** A binder as a refusal names it: its layer name when it has one, and where it sits in the call. */
export function describeBinder(name: string | undefined, where: string): string {
  return (name === undefined ? "" : JSON.stringify(name) + " ") + "at " + where;
}

// A TEXT node's authored content, however it compiled: a plain string, or the runs a markdown/rich
// author produced — undefined when it states neither.
function authoredTextOf(wn: BuiltNode): string | undefined {
  if (typeof wn.text === "string") return wn.text;
  return wn.runs && textOfRuns(wn.runs);
}

/**
 * Write each built node's binding bag onto it, translating the AUTHORED property names to the full
 * names Figma actually files the properties under. Shared by flcm.component (which mints them with
 * addComponentProperty) and by a bound insert into an existing component (component-edit.ts, whose
 * map is mostly names it resolved off the live definitions) — so there is one place that knows a
 * reference stores the suffixed name and merges rather than replaces the node's existing bag.
 */
export function writeBindingReferences(bound: readonly BoundLiveNode[], suffixed: Record<string, string>): void {
  for (const { node, refs } of bound) {
    // A write point per node: a field already referencing the property is not written again.
    const at = realizeAtWritePoint(node, Object.keys(refs).map((field) => `word:binding:${field}` as const));
    const fields = Object.keys(refs).filter((field) => at.writes.has(`word:binding:${field}`));
    if (!fields.length) continue;
    const wire: Record<string, string> = { ...(node.componentPropertyReferences || {}) };
    for (const field of fields) {
      wire[BINDING_FIELD_WIRE_KEYS[field].wire] = suffixed[(refs as Record<string, string>)[field]];
    }
    node.componentPropertyReferences = wire;
    at.landed();
  }
}
