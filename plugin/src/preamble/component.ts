// component — the two verbs that MAKE a component, the write side of what `get` reports about one:
//
//   • flcm.component(specOrTarget, options?) — promote a constructor spec (rendered on the current
//     page exactly as flcm.render would, then converted) or a live node (converted where it stands)
//     into a COMPONENT, declaring its `propertyDefinitions` and wiring each one to the nodes that
//     carry it (`componentPropertyReferences`).
//   • flcm.variants(entries, options) — fold standalone components into a COMPONENT_SET, each entry
//     saying which member of the set its component IS in the set's axes.
//
// READ WORDS ARE WRITE WORDS. `propertyDefinitions` and `componentPropertyReferences` are the read
// shape's own names for these facts, with the read's own lowercase types and field spellings; only
// the wire keys Figma stores (`characters`, `mainComponent`, `slotContentId`) stay hidden here.
//
// Prepare/apply like every mutating verb: everything the document can refuse — the target, the
// instance plans, fonts and images, an instance-swap default's component, every binding name against
// this call's definitions — resolves in prepare with zero writes; the apply span is sync and sealed,
// so one call is one undo step and a Figma refusal rolls the whole thing back.
//
// A SLOT is authored as a bound FRAME, not created: `figma.createSlot()` exists but yields an
// unpositioned 100×100 free-form box, while a plain frame bound with `{ slot: name }` keeps its
// layout in the definition and appears in every instance as a fillable `type: "SLOT"` [verified in
// a live file during the design spike].

import {
  WriteNode, WriteChild, Handle, Target, ComponentPropertyBinding, ComponentResult, VariantEntryInput,
} from "./ir.js";
import { resolveTarget } from "./read.js";
import {
  settleHandles, mintHandle, BoundSpecNode, InstancePlans, beginRenderWalk, RenderResources,
} from "./bridge.js";
import { assertConstructorBuiltTree, isConstructorBuilt, isReadSpec } from "./provenance.js";
import { assertSizingResolvesAgainstParentFrame } from "./layout-legality.js";
import { loadTreeResources, buildTreeOnPage } from "./render.js";
import { enterMutatingVerb } from "./mutation-lock.js";
import { beginMutatingApply } from "./verb-error.js";
import { instanceAncestorOf, readKey, writeKey, describeNodeIdentity, SLOT_CONTENT_WIRE_KEY } from "./identity.js";
import { resolveComponentTarget } from "./instance.js";
import { own, rejectUnknownKeys } from "./validate.js";
import { KNOWN_KEYS, isTargetShaped, COMPONENT_TARGET_HINT } from "./flcm.js";
import type { ComponentOptions, VariantsOptions } from "./schema.js";

const SUBJECT = "flcm.component";
const VARIANTS_SUBJECT = "flcm.variants";

export const quoted = (names: readonly string[]): string => names.map((n) => JSON.stringify(n)).join(", ");

// The read's lowercase property types → Figma's own enum. `variant` is deliberately absent: an axis
// is minted by combining components into a SET, never declared on one (see the refusal below).
export const PROPERTY_TYPES: Record<string, "BOOLEAN" | "TEXT" | "INSTANCE_SWAP" | "SLOT"> = {
  boolean: "BOOLEAN",
  text: "TEXT",
  instance_swap: "INSTANCE_SWAP",
  slot: "SLOT",
};
const PROPERTY_TYPE_WORDS = Object.keys(PROPERTY_TYPES);

// Figma's enum → the read's lowercase word, for a refusal that has only a LIVE definition to go on
// (an edit resolves against `componentPropertyDefinitions`, which speaks the enum).
export const PROPERTY_TYPE_WORD_FOR: Record<string, string> = {};
for (const word of PROPERTY_TYPE_WORDS) PROPERTY_TYPE_WORD_FOR[PROPERTY_TYPES[word]] = word;

// Each binding field: the property type it demands, and the key Figma actually stores it under.
// The author writes the READ's spelling on both sides of the surface; only this table knows the
// wire keys — which is the whole reason a binding is authored rather than hand-written.
export const BINDING_FIELD_WIRE_KEYS: Record<string, { wire: string; type: string }> = {
  visible: { wire: "visible", type: "boolean" },
  text: { wire: "characters", type: "text" },
  componentId: { wire: "mainComponent", type: "instance_swap" },
  slot: { wire: SLOT_CONTENT_WIRE_KEY, type: "slot" },
};

// Which binding field carries a property of each type — the table above inverted, for the
// derived-default lookup ("which node binds this property?"). One field per type is the invariant.
export const FIELD_FOR_TYPE: Record<string, string> = {};
for (const field of Object.keys(BINDING_FIELD_WIRE_KEYS)) FIELD_FOR_TYPE[BINDING_FIELD_WIRE_KEYS[field].type] = field;

const COMPONENT_OPTION_KEYS: ReadonlySet<string> = new Set(KNOWN_KEYS.componentOptions);
const DEFINITION_KEYS: ReadonlySet<string> = new Set(KNOWN_KEYS.propertyDefinition);
const VARIANT_ENTRY_KEYS: ReadonlySet<string> = new Set(KNOWN_KEYS.variantEntry);
const VARIANTS_OPTION_KEYS: ReadonlySet<string> = new Set(KNOWN_KEYS.variantsOptions);

// ---- what an flcm.component call declares, document-blind then resolved ----

/** One `propertyDefinitions` entry as authored: shape-checked, nothing looked up yet. */
export interface AuthoredDefinition {
  name: string;
  /** The read's lowercase word — kept as authored so refusals speak the agent's own vocabulary. */
  type: string;
  figmaType: "BOOLEAN" | "TEXT" | "INSTANCE_SWAP" | "SLOT";
  /** Absent when the author omitted it — the trigger for deriving it from the bound node. */
  defaultValue?: unknown;
}

/** The same definition with its default settled, ready for one addComponentProperty call. */
export interface PreparedDefinition {
  name: string;
  figmaType: "BOOLEAN" | "TEXT" | "INSTANCE_SWAP" | "SLOT";
  defaultValue: boolean | string;
}

/** A spec node carrying bindings, before it is built — what the definition gates read. */
interface BoundSpec {
  wn: WriteNode;
  refs: ComponentPropertyBinding;
}

interface PreparedOptions {
  name?: string;
  description?: string;
  definitions: AuthoredDefinition[];
}

function compileComponentOptions(raw: unknown): PreparedOptions {
  if (raw == null) return { definitions: [] };
  rejectUnknownKeys(raw, COMPONENT_OPTION_KEYS, SUBJECT + " options");
  const bag = raw as Record<string, unknown>;
  const out: PreparedOptions = { definitions: compilePropertyDefinitions(bag.propertyDefinitions) };
  for (const word of ["name", "description"] as const) {
    const value = bag[word];
    if (value == null) continue;
    if (typeof value !== "string") {
      throw new Error(SUBJECT + " options." + word + " must be a string — got " + JSON.stringify(value) + ".");
    }
    out[word] = value;
  }
  return out;
}

function compilePropertyDefinitions(raw: unknown): AuthoredDefinition[] {
  const where = SUBJECT + " options.propertyDefinitions";
  if (raw == null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(where + ' must be an object of definitions by property name, e.g. { Label: { type: "text" } } — got ' + JSON.stringify(raw) + ".");
  }
  const out: AuthoredDefinition[] = [];
  const seen = new Set<string>();
  for (const rawName of Object.keys(raw)) {
    // Trimmed ONCE, here: the dedupe below, a binding's lookup by name, and the name Figma stores
    // must all see one spelling, or `"Label "` and a binding to `"Label"` would refuse each other.
    const name = rawName.trim();
    if (!name) throw new Error(where + ": a property name is empty.");
    // Figma is happy to mint two properties with one display name (the #suffix is the identity);
    // flcm won't, because every later reference — a binding, an instance's componentProperties —
    // addresses a property by that name and would have no way to say which.
    if (seen.has(name)) {
      throw new Error(where + ": two properties are named " + JSON.stringify(name) + ". Names must be unique within the call — a binding names a property, and a duplicate has no way to say which.");
    }
    seen.add(name);
    out.push(compilePropertyDefinition(name, (raw as Record<string, unknown>)[rawName], where + "[" + JSON.stringify(name) + "]"));
  }
  return out;
}

/**
 * One DECLARED property, shape-checked with nothing looked up. Shared by flcm.component's options
 * bag and by an edit's `propertyDefinitions` ADD branch (component-edit.ts), so what a definition IS
 * is stated once — the two callers differ only in what they do about a missing `defaultValue`.
 */
export function compilePropertyDefinition(name: string, raw: unknown, at: string): AuthoredDefinition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(at + ' must be an object like { type: "text", defaultValue: "Save" } — got ' + JSON.stringify(raw) + ".");
  }
  rejectUnknownKeys(raw, DEFINITION_KEYS, at);
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
  const definition: AuthoredDefinition = { name, type: type as string, figmaType };
  const value = bag.defaultValue;
  if (value == null) return definition; // omitted: derived from the bound node (see resolveDefaults)
  if (figmaType === "SLOT") {
    throw new Error(at + ": a slot has no value — its content is authored, by binding the FRAME that IS the slot (componentPropertyReferences: { slot: " + JSON.stringify(name) + " }). Drop `defaultValue`.");
  }
  if (figmaType === "BOOLEAN" && typeof value !== "boolean") {
    throw new Error(at + ": a boolean property's defaultValue is true or false — got " + JSON.stringify(value) + ".");
  }
  if (figmaType === "TEXT" && typeof value !== "string") {
    throw new Error(at + ": a text property's defaultValue is a string — got " + JSON.stringify(value) + ".");
  }
  if (figmaType === "INSTANCE_SWAP" && !isTargetShaped(value)) {
    throw new Error(at + ": an instance-swap property's defaultValue is the component it starts on — " + COMPONENT_TARGET_HINT + ". Got " + JSON.stringify(value) + ".");
  }
  definition.defaultValue = value;
  return definition;
}

// ---- the bindings in the spec ----

// Every bound node in the tree, ROOT EXCLUDED: the root becomes the component itself, so a binding
// on it would name a property of a component that is the node — refused rather than dropped.
function collectBoundSpecs(tree: WriteNode): BoundSpec[] {
  if (tree.componentPropertyReferences) {
    throw new Error(
      SUBJECT + ": the spec's ROOT carries `componentPropertyReferences`, and the root is what BECOMES the component — there is no outer component whose property could drive it. Bind a child instead.",
    );
  }
  const out: BoundSpec[] = [];
  const visit = (wn: WriteChild): void => {
    if (!wn || typeof wn !== "object") return;
    if (wn.componentPropertyReferences) out.push({ wn, refs: wn.componentPropertyReferences });
    for (const child of wn.children || []) visit(child);
  };
  for (const child of tree.children || []) visit(child);
  return out;
}

// Every binding name resolves against THIS call's definitions, and its field must match the
// property's type. Document-blind: the properties don't exist yet, and neither do the nodes.
function assertBindingsResolve(bound: readonly BoundSpec[], definitions: readonly AuthoredDefinition[]): void {
  const declared = definitions.map((d) => d.name);
  for (const { refs } of bound) {
    for (const field of Object.keys(refs)) {
      const name = (refs as Record<string, string>)[field];
      const definition = definitions.find((d) => d.name === name);
      if (!definition) {
        throw new Error(
          SUBJECT + ": `componentPropertyReferences." + field + "` names property " + JSON.stringify(name) + ", which this call doesn't declare — " +
            (declared.length ? "its propertyDefinitions are " + quoted(declared) : "the call declares no propertyDefinitions") + ".",
        );
      }
      const wants = BINDING_FIELD_WIRE_KEYS[field].type;
      if (definition.type !== wants) {
        throw new Error(
          SUBJECT + ": `componentPropertyReferences." + field + "` drives a " + wants + " property, and " + JSON.stringify(name) +
            " is declared " + JSON.stringify(definition.type) + ".",
        );
      }
    }
  }
}

// A slot IS a frame in the definition, so exactly one frame must claim it. Neither end is a value
// flcm can invent: with none, Figma's own createSlot would leave an unpositioned 100×100 box in the
// component; with two, the slot's content would have two places to land.
//
// `form` is what the refusal is FOR: the target form has no spec to add a binding to, so telling it
// to write `componentPropertyReferences` would name a word its own call can't express.
function assertSlotsAreBound(bound: readonly BoundSpec[], definitions: readonly AuthoredDefinition[], form: SubjectForm): void {
  for (const definition of definitions) {
    if (definition.figmaType !== "SLOT") continue;
    const binders = bindersOf(bound, definition);
    if (!binders.length) {
      if (form === "target") {
        throw new Error(
          SUBJECT + ": slot property " + JSON.stringify(definition.name) + " needs the SPEC form. Promoting a live node declares properties but binds nothing to them, and a slot IS a frame in the definition — " +
            "build the component from a spec whose placeholder frame carries `componentPropertyReferences: { slot: " + JSON.stringify(definition.name) + " }`.",
        );
      }
      throw new Error(
        SUBJECT + ": slot property " + JSON.stringify(definition.name) + " is declared but no frame is bound to it. A slot IS a frame in the definition — give the frame that holds the slot's placeholder content " +
          "`componentPropertyReferences: { slot: " + JSON.stringify(definition.name) + " }`, and every instance shows it as a SLOT.",
      );
    }
    if (binders.length > 1) {
      throw new Error(
        SUBJECT + ": " + binders.length + " frames are bound to slot property " + JSON.stringify(definition.name) + ", and a slot is one hole. Bind the one frame the content goes into.",
      );
    }
  }
}

function bindersOf(bound: readonly BoundSpec[], definition: AuthoredDefinition): BoundSpec[] {
  const field = FIELD_FOR_TYPE[definition.type];
  return bound.filter((b) => (b.refs as Record<string, string>)[field] === definition.name);
}

// ---- the defaults ----

// Settle every definition's default. An explicit instance-swap target resolves to the COMPONENT's
// id (the only form Figma stores); an omitted default is DERIVED from the single node that binds
// the property, because that node already states the value the component starts at — a bound text's
// content, a bound layer's visibility, a bound instance's component. Nothing binds it and nothing
// was passed: refused, since a silent "" or `true` would be an invented design decision.
async function resolveDefaults(
  definitions: readonly AuthoredDefinition[], bound: readonly BoundSpec[], plans: InstancePlans, form: SubjectForm,
): Promise<PreparedDefinition[]> {
  const out: PreparedDefinition[] = [];
  for (const definition of definitions) {
    out.push({ name: definition.name, figmaType: definition.figmaType, defaultValue: await defaultFor(definition, bound, plans, form) });
  }
  return out;
}

async function defaultFor(
  definition: AuthoredDefinition, bound: readonly BoundSpec[], plans: InstancePlans, form: SubjectForm,
): Promise<boolean | string> {
  const at = SUBJECT + " options.propertyDefinitions[" + JSON.stringify(definition.name) + "]";
  // A slot's "value" is the empty string Figma wants; its content is the bound frame.
  if (definition.figmaType === "SLOT") return "";
  if (definition.defaultValue !== undefined) {
    if (definition.figmaType !== "INSTANCE_SWAP") return definition.defaultValue as boolean | string;
    const resolved = await resolveComponentTarget(definition.defaultValue as Target, at);
    return resolved.base.id;
  }
  const binders = bindersOf(bound, definition);
  if (!binders.length) {
    if (form === "target") {
      throw new Error(
        at + ": no `defaultValue`, and promoting a live node binds nothing to this property — so there is no node to read the starting value off. " +
          "Pass `defaultValue`, or build the component from a spec, where the bound node supplies it.",
      );
    }
    throw new Error(
      at + ": no `defaultValue`, and nothing in this call binds " + JSON.stringify(definition.name) + " — so there is no node to read the starting value off. " +
        "Pass `defaultValue`, or bind a node with componentPropertyReferences: { " + FIELD_FOR_TYPE[definition.type] + ": " + JSON.stringify(definition.name) + " }.",
    );
  }
  if (binders.length > 1) {
    throw new Error(
      at + ": " + binders.length + " nodes bind " + JSON.stringify(definition.name) + ", so there is no single value to derive its default from. Pass `defaultValue`.",
    );
  }
  const wn = binders[0].wn;
  if (definition.figmaType === "BOOLEAN") return wn.visible !== false; // an unnamed `visible` is true
  if (definition.figmaType === "TEXT") return specTextOf(wn);
  // The bound node is an INSTANCE spec (the constructors allow `componentId` on nothing else), and
  // its plan already holds the component this call will actually STAMP — which is the point: when
  // the spec names a SET and picks a member with `componentProperties`, re-resolving the target here
  // would land on the set's DEFAULT variant and the definition's default would disagree with the very
  // node it was derived from.
  return plans.get(wn)!.component.id;
}

// A TEXT spec's content, however it compiled: a plain string, or the runs a markdown/rich author
// produced (concatenated exactly as the bridge concatenates them into `characters`).
function specTextOf(wn: WriteNode): string {
  if (typeof wn.text === "string") return wn.text;
  return (wn.runs || []).map((run) => run.text).join("");
}

// ---- the live subject ----

/** Which of the verb's two forms a refusal is speaking to — they can express different fixes. */
type SubjectForm = "spec" | "target";

// The one place a spec and a target are told apart — provenance first, exactly as the structural
// verbs do it (ADR-0012), because a `get` result and a handle both carry a string `id` and only
// object identity can separate them.
function classifySubject(thing: unknown): SubjectForm {
  if (typeof thing === "string") return "target";
  if (isConstructorBuilt(thing as object)) return "spec";
  if (thing && typeof thing === "object" && !Array.isArray(thing)) {
    if (isReadSpec(thing) || "children" in (thing as Record<string, unknown>)) {
      throw new Error(
        SUBJECT + ": that is a `get` result, and a read spec is not authoring input on its own — promoting it would turn the node you READ into a component, not a copy of it. " +
          "Say which you mean: " + SUBJECT + "(flcm.fromRead(spec)) rebuilds it as a new component, " + SUBJECT + "(spec.id) promotes the live node.",
      );
    }
    if (isTargetShaped(thing)) return "target";
    if (typeof (thing as WriteNode).type === "string") assertConstructorBuiltTree(thing as WriteNode);
  }
  throw new Error(
    SUBJECT + ": the first argument is what becomes the component — a node from the flcm constructors, or a target naming a live node (an flcm/key, a node id, flcm.id(id), or a handle). Got " + JSON.stringify(thing) + ".",
  );
}

// Figma's createComponentFromNode "behaves like the Create component button": handed a node it can't
// CONVERT it wraps it in a new component frame instead. That is never what the call asked for, and
// worse it is silent — so both forms refuse the wrappable cases with this one sentence rather than
// hand back a component around the thing the agent wanted to BE the component.
const WOULD_WRAP =
  "Figma would WRAP it in a new component rather than turn it into one, so flcm refuses rather than build something you didn't ask for";

// Everything that disqualifies a SPEC ROOT from being promoted. A leaf spec — a text, a shape, a
// path, an instance — is exactly the wrappable case above, and the mismatch is silent twice over:
// the key the author put on the root would end up on the wrapper, not on the node they keyed.
// Judged in prepare, before a single node is built, so a refusal costs nothing.
function assertPromotableSpecRoot(spec: WriteNode): void {
  if (spec.type === "FRAME") return;
  // The one non-FRAME spec that builds a frame: createNodeFromSvg returns a FrameNode of vectors.
  // flcm.path (also a VECTOR spec) builds a real VECTOR, so it falls through to the refusal.
  if (spec.type === "VECTOR" && typeof spec.svg === "string") return;
  if (spec.type === "INSTANCE") {
    throw new Error(
      SUBJECT + ": the spec's root is an flcm.instance. " + WOULD_WRAP + " — author the body you want as the component " +
        "(an instance's own layers aren't editable anyway), or flcm.render it, flcm.detach the result, and promote that.",
    );
  }
  throw new Error(
    SUBJECT + ": the spec's root is a " + spec.type + ", and a component's root is a frame. " + WOULD_WRAP +
      " — wrap it yourself so the layout is yours: " + SUBJECT + "(flcm.frame({ … }, [node])).",
  );
}

// Everything that disqualifies a LIVE node from being promoted, each named for what it is rather
// than left to Figma (whose own refusals name neither the node nor the fix — and whose INSTANCE
// behavior is not a refusal at all, but a silent wrapping).
function assertPromotable(node: any): void {
  const who = describeNodeIdentity(node);
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    throw new Error(
      SUBJECT + ": " + who + " is already a component — there is nothing to promote. Edit it with flcm.edit, stamp it with flcm.instance, or " +
        (node.type === "COMPONENT" ? "make it a variant with flcm.variants." : "add to the set with flcm.variants."),
    );
  }
  if (node.type === "INSTANCE") {
    throw new Error(
      SUBJECT + ": " + who + " is an instance. " + WOULD_WRAP + " — flcm.detach it first (it becomes ordinary layers), or promote what you actually want inside it.",
    );
  }
  if (node.type === "SLOT") {
    throw new Error(SUBJECT + ": " + who + " is a SLOT — a hole an instance fills, not a node of its own to promote. Promote the frame that holds the content you mean.");
  }
  if (node.type === "PAGE") {
    throw new Error(SUBJECT + ": that is a PAGE, not a node on it — name the frame to promote (flcm.find locates it).");
  }
  const host = instanceAncestorOf(node);
  if (host) {
    throw new Error(
      SUBJECT + ": " + who + " is inside component instance " + JSON.stringify(host.name) + " (id " + JSON.stringify(host.id) +
        "), whose child list Figma won't let a plugin change — promoting it would take it out of that list. Promote the same node in the main component it comes from (flcm never auto-detaches).",
    );
  }
  // Figma's own rule, stated in createComponentFromNode's docs: the node "cannot be inside a
  // component, component set, or instance", and reaching it throws a bare "Cannot create component
  // from node" after the seal. Named here instead, because a component's sublayer is a node the
  // agent can see and address — and the fix depends on which of the two things they meant.
  const owner = componentAncestorOf(node);
  if (owner) {
    throw new Error(
      SUBJECT + ": " + who + " is inside " + (owner.type === "COMPONENT_SET" ? "component set " : "component ") + JSON.stringify(owner.name) +
        " (id " + JSON.stringify(owner.id) + ") — Figma won't make a component out of a component's own sublayer (createComponentFromNode throws). " +
        "Edit the component it is in, or promote a COPY of the sublayer: " + SUBJECT + "(flcm.fromRead(await flcm.get(" + JSON.stringify(node.id) + "))).",
    );
  }
}

/**
 * The COMPONENT (or COMPONENT_SET) a node sits inside, or null. THE test for "does this node belong
 * to a definition" — flcm.component refuses to promote a node that does, and a binding edit requires
 * it. Caller beware: a node inside an INSTANCE that itself sits in a component answers the OUTER
 * component, so an instance-ancestor check comes first wherever the two are different questions.
 */
export function componentAncestorOf(node: any): any {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "COMPONENT" || p.type === "COMPONENT_SET") return p;
  }
  return null;
}

// ---- the sealed apply ----

// Name, description, the properties, and the bindings that point at them — everything the promotion
// itself doesn't carry. Figma hands back a SUFFIXED name from addComponentProperty ("Label#12:3"),
// and that is what a reference must store, so the bindings are written from this map and never from
// the authored name.
function declareProperties(comp: any, definitions: readonly PreparedDefinition[], bound: readonly BoundSpecNode[], options: PreparedOptions): void {
  if (options.name != null) comp.name = options.name;
  if (options.description != null) comp.description = options.description;
  const suffixed: Record<string, string> = {};
  for (const definition of definitions) {
    suffixed[definition.name] = comp.addComponentProperty(definition.name, definition.figmaType, definition.defaultValue);
  }
  writeBindingReferences(bound, suffixed);
}

/**
 * Write each built node's binding bag onto it, translating the AUTHORED property names to the full
 * names Figma actually files the properties under. Shared by flcm.component (which mints them with
 * addComponentProperty) and by a bound insert into an existing component (component-edit.ts, whose
 * map is mostly names it resolved off the live definitions) — so there is one place that knows a
 * reference stores the suffixed name and merges rather than replaces the node's existing bag.
 */
export function writeBindingReferences(bound: readonly BoundSpecNode[], suffixed: Record<string, string>): void {
  for (const { node, refs } of bound) {
    const wire: Record<string, string> = { ...(node.componentPropertyReferences || {}) };
    for (const field of Object.keys(refs)) {
      wire[BINDING_FIELD_WIRE_KEYS[field].wire] = suffixed[(refs as Record<string, string>)[field]];
    }
    node.componentPropertyReferences = wire;
  }
}

// The TARGET form's keyed map: read back off the subtree's pluginData, since no walk of ours built
// it. A key that appears twice (two earlier calls stamped it) refuses, as stampKey does within one
// render — last-wins would hand the agent a handle to the wrong node.
function collectKeyed(root: any): Record<string, any> {
  const keyed: Record<string, any> = {};
  const visit = (node: any): void => {
    const key = readKey(node);
    if (key) {
      if (keyed[key]) {
        throw new Error(
          SUBJECT + ": two nodes inside " + describeNodeIdentity(root) + " carry the flcm/key " + JSON.stringify(key) + " (" +
            JSON.stringify(keyed[key].id) + " and " + JSON.stringify(node.id) + "), so `keyed` can't name one. Address them by id, or rebuild one under a fresh key.",
        );
      }
      keyed[key] = node;
    }
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  return keyed;
}

interface PreparedSpecComponent {
  kind: "spec";
  spec: WriteNode;
  resources: RenderResources;
  definitions: PreparedDefinition[];
  options: PreparedOptions;
}

interface PreparedTargetComponent {
  kind: "target";
  node: any;
  definitions: PreparedDefinition[];
  options: PreparedOptions;
}

/**
 * flcm.component(specOrTarget, options?) — make a COMPONENT. A spec is rendered on the current page
 * exactly as flcm.render would render it (same gates, same resources, same root placement) and then
 * converted; a target is converted where it stands. Returns the COMPONENT's own handle — Figma mints
 * a NEW node for it, so the promoted frame's id is not the component's — plus every keyed node in
 * its subtree.
 */
// A single expression on purpose: the queue slot is reserved before component() can possibly yield,
// which is the lock's invocation-order guarantee (see enterMutatingVerb) — don't add work above it.
export function component(specOrTarget: WriteNode | Target, options?: ComponentOptions): Promise<ComponentResult> {
  return enterMutatingVerb(
    "component",
    async (): Promise<PreparedSpecComponent | PreparedTargetComponent> => {
      const prepared = compileComponentOptions(options);
      if (classifySubject(specOrTarget) === "target") {
        const node: any = await resolveTarget(specOrTarget as Target);
        assertPromotable(node);
        // No spec, so nothing binds anything: a definition without an explicit default, and any
        // slot at all, refuse here naming what THIS form can pass.
        assertSlotsAreBound([], prepared.definitions, "target");
        return { kind: "target", node, definitions: await resolveDefaults(prepared.definitions, [], new Map(), "target"), options: prepared };
      }
      const spec = specOrTarget as WriteNode;
      assertConstructorBuiltTree(spec);
      assertPromotableSpecRoot(spec);
      // The component lands on the page like any render root, and the page has no bounded size to
      // resolve "fill" or a percent against — render's own gate, shared so both verbs answer alike.
      if (spec.layout) assertSizingResolvesAgainstParentFrame(spec.layout, true, "flcm");
      const bound = collectBoundSpecs(spec);
      assertBindingsResolve(bound, prepared.definitions);
      assertSlotsAreBound(bound, prepared.definitions, "spec");
      const resources = await loadTreeResources(spec);
      // Defaults AFTER the resources: a derived instance-swap default reads the instance plan the
      // load just built, rather than resolving the same target a second time to a different answer.
      return { kind: "spec", spec, resources, definitions: await resolveDefaults(prepared.definitions, bound, resources.instances, "spec"), options: prepared };
    },
    (prepared) => (prepared.kind === "spec" ? applySpecComponent(prepared) : applyTargetComponent(prepared)),
  );
}

function applySpecComponent({ spec, resources, definitions, options }: PreparedSpecComponent): ComponentResult {
  // One of the two ctxs that opt INTO binding collection — this verb declares the properties in the
  // same call; the other is an insert landing inside a component (structure.ts's applyInsert, which
  // has one already declaring them). See RenderCtx.bindings.
  const ctx = beginRenderWalk(resources, { bindings: true });
  // render's own build sequence, shared rather than copied (render.buildTreeOnPage): the spec lands
  // exactly as flcm.render would land it, overlap notice included. Only then is there a laid-out
  // node to convert.
  const root = buildTreeOnPage(spec, ctx);
  // The seal opens on the FRAME, before the conversion: createComponentFromNode is the likeliest
  // Figma refusal in this verb, and the frame is the identity the author authored and can act on
  // (the component it would have become doesn't exist to be named).
  const fail = beginMutatingApply("component", root);
  try {
    const comp = figma.createComponentFromNode(root);
    // The root's own key rides across by hand: createComponentFromNode returns a NEW node, so the
    // pluginData stamped on the frame belongs to a node that no longer exists. Children keep theirs
    // (Figma moves the same nodes), so the walk's own `keyed` map stays right except at the root.
    if (typeof spec.key === "string") {
      writeKey(comp, spec.key);
      ctx.keyed[spec.key] = comp;
    }
    declareProperties(comp, definitions, ctx.bindings!, options);
    return settleHandles(comp, ctx.keyed);
  } catch (cause) {
    throw fail(cause);
  }
}

function applyTargetComponent({ node, definitions, options }: PreparedTargetComponent): ComponentResult {
  const fail = beginMutatingApply("component", node);
  try {
    // Read the key BEFORE the conversion and re-stamp it after, exactly as the spec form does:
    // createComponentFromNode hands back a new node, and whether Figma carries pluginData across is
    // undocumented. Re-stamping is right under either answer, and keeps the two forms symmetric.
    const key = readKey(node);
    const comp = figma.createComponentFromNode(node);
    if (key) writeKey(comp, key);
    declareProperties(comp, definitions, [], options);
    return settleHandles(comp, collectKeyed(comp));
  } catch (cause) {
    throw fail(cause);
  }
}

// ---- flcm.variants ----

/** One entry, shape-checked and spelled as the layer name Figma parses its axes out of. */
interface AuthoredVariant {
  component: Target;
  /** "Size=Large, State=Default" — the axes in the FIRST entry's key order. */
  name: string;
}

interface PreparedVariants {
  members: { node: any; name: string }[];
  parent: any;
  index: number;
  options: VariantsOptions;
}

function compileVariantsOptions(raw: unknown): VariantsOptions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(VARIANTS_SUBJECT + ' takes options naming the set: { name: "Button", description? } — got ' + JSON.stringify(raw) + ".");
  }
  rejectUnknownKeys(raw, VARIANTS_OPTION_KEYS, VARIANTS_SUBJECT + " options");
  const bag = raw as Record<string, unknown>;
  if (typeof bag.name !== "string" || !bag.name.trim()) {
    throw new Error(
      VARIANTS_SUBJECT + " options.name is required — a set left unnamed takes the first member's axes as its name (\"Size=Large, State=Default\"), which is not a name anyone meant. Got " + JSON.stringify(bag.name) + ".",
    );
  }
  const options: VariantsOptions = { name: bag.name };
  if (bag.description != null) {
    if (typeof bag.description !== "string") {
      throw new Error(VARIANTS_SUBJECT + " options.description must be a string — got " + JSON.stringify(bag.description) + ".");
    }
    options.description = bag.description;
  }
  return options;
}

// Figma parses a variant's axes out of its LAYER NAME ("Size=Large, State=Default"), so `=` and `,`
// are the grammar itself: a value carrying either would silently split into different axes.
// Returns the TRIMMED word: Figma trims around `=` and `,` when it parses the name, so `" Large"` and
// `"Large"` are one variant to it — and must be one to the uniqueness check here.
function assertAxisWord(value: unknown, what: string, at: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(at + ": a variant " + what + " is a non-empty string — got " + JSON.stringify(value) + ".");
  }
  if (value.indexOf("=") !== -1 || value.indexOf(",") !== -1) {
    throw new Error(
      at + ": a variant " + what + " can't contain \"=\" or \",\" — Figma spells a variant's axes in its layer name (\"Size=Large, State=Default\"), so those two characters ARE the grammar. Got " + JSON.stringify(value) + ".",
    );
  }
  return value.trim();
}

function compileVariantEntries(raw: unknown): AuthoredVariant[] {
  if (!Array.isArray(raw) || !raw.length) {
    throw new Error(
      VARIANTS_SUBJECT + ' takes a non-empty array of { component, variant }, e.g. [{ component: small, variant: { Size: "Small" } }, { component: large, variant: { Size: "Large" } }] — got ' + JSON.stringify(raw) + ".",
    );
  }
  const axes: string[] = [];
  const combinations = new Map<string, number>();
  const out: AuthoredVariant[] = [];
  for (let i = 0; i < raw.length; i++) {
    const at = VARIANTS_SUBJECT + " entries[" + i + "]";
    const entry = raw[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(at + " must be an object like { component, variant } — got " + JSON.stringify(entry) + ".");
    }
    rejectUnknownKeys(entry, VARIANT_ENTRY_KEYS, at);
    const { component: target, variant } = entry as { component?: unknown; variant?: unknown };
    if (!isTargetShaped(target)) {
      throw new Error(at + ".component must be " + COMPONENT_TARGET_HINT + " — got " + JSON.stringify(target) + ".");
    }
    if (!variant || typeof variant !== "object" || Array.isArray(variant)) {
      throw new Error(at + '.variant says which member of the set this component IS, in the set\'s axes: { Size: "Large", State: "Default" }. Got ' + JSON.stringify(variant) + ".");
    }
    const rawAxes = Object.keys(variant);
    if (!rawAxes.length) throw new Error(at + ".variant names no axes — a set is made OF its axes, so every entry names at least one.");
    const values: Record<string, string> = {};
    for (const axis of rawAxes) {
      const name = assertAxisWord(axis, "axis name", at + ".variant");
      values[name] = assertAxisWord((variant as Record<string, unknown>)[axis], "value", at + ".variant[" + JSON.stringify(axis) + "]");
    }
    const named = Object.keys(values);
    // The FIRST entry fixes both the axis set and the order they are spelled in.
    if (!axes.length) axes.push(...named);
    else assertSameAxes(axes, named, at);
    const name = axes.map((axis) => axis + "=" + values[axis]).join(", ");
    const twin = combinations.get(name);
    if (twin !== undefined) {
      throw new Error(VARIANTS_SUBJECT + ": entries[" + twin + "] and entries[" + i + "] are both " + JSON.stringify(name) + " — every combination in a set is unique.");
    }
    combinations.set(name, i);
    out.push({ component: target, name });
  }
  return out;
}

function assertSameAxes(axes: readonly string[], named: readonly string[], at: string): void {
  const missing = axes.filter((axis) => named.indexOf(axis) === -1);
  const extra = named.filter((axis) => axes.indexOf(axis) === -1);
  if (!missing.length && !extra.length) return;
  throw new Error(
    at + ": every entry names the SAME axes (order doesn't matter). The first entry names " + quoted(axes) +
      (missing.length ? "; this one is missing " + quoted(missing) : "") +
      (extra.length ? "; this one adds " + quoted(extra) : "") + ".",
  );
}

// Where the SET lands in `parent`. Counted among the nodes that SURVIVE the combine, because every
// member is pulled out of `parent` before the set is inserted: a raw indexOf of the first member is
// a pre-removal slot, and whenever another member sits ahead of it in page order that index outruns
// the shortened child list — page [b, a] with entries [a, b] asks for slot 1 of a parent left with
// none, which the live insertChild family throws on.
function setIndexAmongSurvivors(members: readonly { node: any }[], parent: any): number {
  const siblings: any[] = parent.children;
  const first = siblings.indexOf(members[0].node);
  let index = 0;
  for (let i = 0; i < first; i++) {
    if (!members.some((m) => m.node === siblings[i])) index++;
  }
  return index;
}

function assertCombinable(node: any, at: string): void {
  const who = describeNodeIdentity(node);
  if (node.parent && node.parent.type === "COMPONENT_SET") {
    throw new Error(
      at + ": " + who + " is already a variant of set " + JSON.stringify(node.parent.name) + " (id " + JSON.stringify(node.parent.id) +
        ") — a component belongs to one set. Combine components that stand on their own, or edit the set it is in.",
    );
  }
  if (node.type !== "COMPONENT") {
    throw new Error(
      at + ": " + who + " is not a component" +
        (node.type === "COMPONENT_SET" ? " but a variant SET — its members are already variants; combine standalone components instead." : ". Make it one first: flcm.component(target), then combine.") ,
    );
  }
  if (node.remote) {
    throw new Error(at + ": " + who + " comes from a library, so this file only holds a reference to it — a set can only be built from components that live here.");
  }
}

/**
 * flcm.variants(entries, options) — fold standalone components into a COMPONENT_SET. Each entry
 * names the SAME axes; the set lands under the FIRST component's parent, at its index, and members
 * elsewhere are moved into it. Returns the set's handle — which is what flcm.instance then takes,
 * selecting a member through `componentProperties`.
 */
// A single expression on purpose — see enterMutatingVerb on the invocation-order guarantee.
export function variants(entries: VariantEntryInput[], options: VariantsOptions): Promise<Handle> {
  return enterMutatingVerb(
    "variants",
    async (): Promise<PreparedVariants> => {
      const opts = compileVariantsOptions(options);
      const authored = compileVariantEntries(entries);
      const members: { node: any; name: string }[] = [];
      for (let i = 0; i < authored.length; i++) {
        const at = VARIANTS_SUBJECT + " entries[" + i + "]";
        const node: any = await resolveTarget(authored[i].component);
        assertCombinable(node, at);
        const twin = members.findIndex((m) => m.node === node);
        if (twin !== -1) {
          throw new Error(VARIANTS_SUBJECT + ": entries[" + twin + "] and entries[" + i + "] name the same component (" + describeNodeIdentity(node) + ") — one component is one variant.");
        }
        members.push({ node, name: authored[i].name });
      }
      const parent = members[0].node.parent;
      if (!parent) {
        throw new Error(
          VARIANTS_SUBJECT + ": " + describeNodeIdentity(members[0].node) + " has no parent for the set to land in — the set takes the first component's place. Put it on a page first.",
        );
      }
      // Under `documentAccess: dynamic-page` a PageNode's `children` throws until it is loaded, and
      // the first member may live on a page that isn't current.
      if (parent.type === "PAGE") await parent.loadAsync();
      return { members, parent, index: setIndexAmongSurvivors(members, parent), options: opts };
    },
    ({ members, parent, index, options: opts }) => {
      const fail = beginMutatingApply("variants", members[0].node);
      try {
        // The names ARE the axes — combineAsVariants reads each member's layer name to build them.
        for (const member of members) member.node.name = member.name;
        const set: any = figma.combineAsVariants(members.map((m) => m.node), parent, index);
        set.name = opts.name;
        if (opts.description != null) set.description = opts.description;
        return mintHandle(set);
      } catch (cause) {
        throw fail(cause);
      }
    },
  );
}
