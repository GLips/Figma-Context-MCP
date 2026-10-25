/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { sceneFigma as figma } from "./scene-access.js";
// component — the two verbs that MAKE a component, the write side of what `get` reports about one:
//
//   • flcm.component(nodeOrTarget, options?) — promote a compiled node (rendered on the current
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
// Prepare/gate/apply like every mutating verb (mutation-lock.ts): the targets, fonts and images
// resolve in prepare; everything the document can refuse — whether the target can be promoted,
// the instance plans, every binding name against this call's definitions, every default its
// binders state — is decided in the synchronous gate with zero writes; the apply span is
// sync and sealed, so one call is one undo step and a Figma refusal rolls the whole thing back.
//
// A SLOT is authored as a bound FRAME, not created: `figma.createSlot()` exists but yields an
// unpositioned 100×100 free-form box, while a plain frame bound with `{ slot: name }` keeps its
// layout in the definition and appears in every instance as a fillable `type: "SLOT"` [verified in
// a live file during the design spike].

import { WriteNode, BuiltNode, Handle, Target, ComponentPropertyBinding, VariantEntryInput } from "./ir.js";
import { applyExposures } from "./instance-exposure.js";
import { resolveTarget, isTargetShaped, COMPONENT_TARGET_HINT } from "./target.js";
import { mintHandle, BoundLiveNode, InstancePlans, beginRenderWalk, RenderResources } from "./bridge.js";
import { compileTree, placedTreeOf } from "./compile-tree.js";
import {
  BINDING_FIELD_WIRE_KEYS, FIELD_FOR_TYPE, quoted, compilePropertyDefinition, bindingsOf, describeBinder, boundLayerValue, agreedDefault,
  FRESH_LAYER_SHOWS, writeInheritedDefault, writeBindingReferences, type AuthoredDefinition, type PreparedDefinition, type LiveBindings,
} from "./component-properties.js";
import type { NodeSpec, AuthoredTree } from "./schema.js";
import { assertSizingResolvesAgainstParentFrame, foldDesignedSizeForPage } from "./layout-legality.js";
import { landTree } from "./land-tree.js";
import { loadTreeResources, gateTreeResources, type LoadedTreeResources } from "./verb-resources.js";
import { enterMutatingVerb, retargetReplacedNode, type VerbResultBuilder } from "./mutation-lock.js";
import type { ApplySpan } from "./apply-span.js";
import { assertNodeStillOnCanvas, createLoadedPages, loadPageForWrite, assertPageLoaded } from "./freshness.js";
import { beginMutatingApply } from "./verb-error.js";
import { FlcmError, describeNodeIdentity } from "./flcm-error.js";
import { recordObligations, supersedeObligations } from "./obligation.js";
import { deriveDeclarationObligations, obligationsOnTarget } from "./obligation-derivation.js";
import { instanceAncestorOf, editableComponentOwnerOf, isComponentDefinition, variantSetOf, readKey, writeKey } from "./identity.js";
import { own, rejectUnknownKeys } from "./validate.js";

import type { ComponentOptions, VariantsOptions } from "./schema.js";
import { wordsOf } from "./vocabulary.js";

const SUBJECT = "flcm.component";
const VARIANTS_SUBJECT = "flcm.variants";

const COMPONENT_OPTION_KEYS = wordsOf(["componentOptions"]);
const VARIANT_ENTRY_KEYS = wordsOf(["variantEntry"]);
const VARIANTS_OPTION_KEYS = wordsOf(["variantsOptions"]);

// ---- what an flcm.component call declares, document-blind then resolved ----

/** A compiled node carrying bindings, before it is built — what the definition gates read. */
interface BoundWriteNode {
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
  rejectUnknownKeys(raw, COMPONENT_OPTION_KEYS, SUBJECT + ".options", { reference: "components" });
  const bag = raw as Record<string, unknown>;
  const out: PreparedOptions = { definitions: compilePropertyDefinitions(bag.propertyDefinitions) };
  for (const word of ["name", "description"] as const) {
    const value = bag[word];
    if (value == null) continue;
    if (typeof value !== "string") {
      throw new FlcmError("authoring", "must be a string — got " + JSON.stringify(value) + ".", { path: SUBJECT + ".options." + word });
    }
    out[word] = value;
  }
  return out;
}

function compilePropertyDefinitions(raw: unknown): AuthoredDefinition[] {
  const where = SUBJECT + ".options.propertyDefinitions";
  if (raw == null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new FlcmError("authoring", 'must be an object of definitions by property name, e.g. { Label: { type: "text" } } — got ' + JSON.stringify(raw) + ".", { path: where });
  }
  const out: AuthoredDefinition[] = [];
  const seen = new Set<string>();
  for (const rawName of Object.keys(raw)) {
    // Trimmed ONCE, here: the dedupe below, a binding's lookup by name, and the name Figma stores
    // must all see one spelling, or `"Label "` and a binding to `"Label"` would refuse each other.
    const name = rawName.trim();
    if (!name) throw new FlcmError("authoring", "a property name is empty.", { path: where });
    // Figma is happy to mint two properties with one display name (the #suffix is the identity);
    // flcm won't, because every later reference — a binding, an instance's componentProperties —
    // addresses a property by that name and would have no way to say which.
    if (seen.has(name)) {
      throw new FlcmError("authoring", "two properties are named " + JSON.stringify(name) + ". Names must be unique within the call — a binding names a property, and a duplicate has no way to say which.", { path: where });
    }
    seen.add(name);
    out.push(compilePropertyDefinition(name, (raw as Record<string, unknown>)[rawName], where + "[" + JSON.stringify(name) + "]"));
  }
  return out;
}

// ---- the bindings in the tree ----

// Every bound node in the tree, ROOT EXCLUDED: the root becomes the component itself, so a binding
// on it would name a property of a component that is the node — refused rather than dropped.
function collectChildBindings(tree: WriteNode, live: LiveBindings): BoundWriteNode[] {
  if (bindingsOf(tree, live)) {
    throw new FlcmError("authoring",
      "the root is what BECOMES the component, so there is no outer component whose property could drive it. Move `componentPropertyReferences` onto a child.",
      { path: tree.sourcePath + ".componentPropertyReferences" },
    );
  }
  const out: BoundWriteNode[] = [];
  const visit = (wn: WriteNode): void => {
    const refs = bindingsOf(wn, live);
    if (refs) out.push({ wn, refs });
    for (const child of wn.children ?? []) visit(child);
  };
  for (const child of tree.children ?? []) visit(child);
  return out;
}

// Every binding name resolves against THIS call's definitions, and its field must match the
// property's type. Document-blind: the properties don't exist yet, and neither do the nodes.
function assertBindingsResolve(bound: readonly BoundWriteNode[], definitions: readonly AuthoredDefinition[]): void {
  const declared = definitions.map((d) => d.name);
  for (const { wn, refs } of bound) {
    for (const field of Object.keys(refs)) {
      const at = wn.sourcePath + ".componentPropertyReferences." + field;
      const name = (refs as Record<string, string>)[field];
      const definition = definitions.find((d) => d.name === name);
      if (!definition) {
        throw new FlcmError("authoring",
          "property " + JSON.stringify(name) + " isn't declared by this call — " +
            (declared.length ? "its propertyDefinitions are " + quoted(declared) : "the call declares no propertyDefinitions") +
            ". Declare it in options.propertyDefinitions, or bind one that is declared.",
          { path: at },
        );
      }
      const wants = BINDING_FIELD_WIRE_KEYS[field].type;
      if (definition.type !== wants) {
        const matching = FIELD_FOR_TYPE[definition.type];
        throw new FlcmError("authoring",
          "`" + field + "` is driven by a " + JSON.stringify(wants) + " property, and " + JSON.stringify(name) + " is declared " + JSON.stringify(definition.type) +
            ". Bind it from " + (matching ? "`" + matching + "`" : "a field of its type") + ", or declare it " + JSON.stringify(wants) + ".",
          { path: at },
        );
      }
    }
  }
}

// A slot IS a frame in the definition, so exactly one frame must claim it. Neither end is a value
// flcm can invent: with none, Figma's own createSlot would leave an unpositioned 100×100 box in the
// component; with two, the slot's content would have two places to land.
function assertSlotsAreBound(bound: readonly BoundWriteNode[], definitions: readonly AuthoredDefinition[]): void {
  for (const definition of definitions) {
    if (definition.figmaType !== "SLOT") continue;
    const binders = bindersOf(bound, definition);
    if (!binders.length) {
      throw new FlcmError("authoring",
        "slot property " + JSON.stringify(definition.name) + " is declared but no frame is bound to it. A slot IS a frame in the definition — give the frame that holds the slot's placeholder content " +
          "`componentPropertyReferences: { slot: " + JSON.stringify(definition.name) + " }`, and every instance shows it as a SLOT.",
        { path: SUBJECT + ".options.propertyDefinitions[" + JSON.stringify(definition.name) + "]" },
      );
    }
    if (binders.length > 1) {
      throw new FlcmError("authoring",
        binders.length + " frames are bound to slot property " + JSON.stringify(definition.name) + " (at " + binders.map((b) => b.wn.sourcePath).join(", ") +
          "), and a slot is one hole. Bind only the frame the content goes into.",
        { path: SUBJECT + ".options.propertyDefinitions[" + JSON.stringify(definition.name) + "]" },
      );
    }
  }
}

function bindersOf(bound: readonly BoundWriteNode[], definition: AuthoredDefinition): BoundWriteNode[] {
  const field = FIELD_FOR_TYPE[definition.type];
  return bound.filter((b) => (b.refs as Record<string, string>)[field] === definition.name);
}

// ---- the defaults ----

// Every definition's default, read off the nodes that bind it. In a main component Figma keeps a
// property's default and its bound layer identical — binding writes the default INTO the layer — so
// a default stated anywhere else would overwrite the layer's real content (an agent promoting
// existing links typed "Link 1"… and lost them). The layer is the one place the value lives.
function resolveDefaults(
  definitions: readonly AuthoredDefinition[], bound: readonly BoundWriteNode[], plans: InstancePlans, live: RenderResources["live"], targetForm: boolean,
): PreparedDefinition[] {
  return definitions.map((definition) => {
    const at = SUBJECT + ".options.propertyDefinitions[" + JSON.stringify(definition.name) + "]";
    // A slot's "value" is the empty string Figma wants; its content is the bound frame.
    if (definition.figmaType === "SLOT") return { name: definition.name, figmaType: "SLOT", defaultValue: "" };
    const nodes = bindersOf(bound, definition).map(({ wn }) => wn);
    const binders = nodes.map((wn) => ({
      layer: describeBinder(wn.liveId === undefined ? wn.name : live.get(wn)!.node.name, wn.sourcePath!),
      value: boundLayerValue(definition.figmaType, wn, plans, live),
    }));
    const defaultValue = agreedDefault(definition, binders, at, { inherited: FRESH_LAYER_SHOWS[definition.figmaType], unboundRemedy: targetForm ? promoteThenBind(definition) : undefined });
    for (const wn of nodes) writeInheritedDefault(definition.figmaType, wn, defaultValue);
    return { name: definition.name, figmaType: definition.figmaType, defaultValue };
  });
}

// A bare target (a live root with no authored children) has nowhere to write a binding. Both ways out bind
// live layers without retyping their content.
function promoteThenBind(definition: AuthoredDefinition): string {
  const binding = "componentPropertyReferences: { " + FIELD_FOR_TYPE[definition.type] + ": " + JSON.stringify(definition.name) + " }";
  return "a bare target has no layer to bind. Pass the frame as data and bind its live layer — flcm.component({ id: frame, children: [{ id: layer, " + binding +
    " }] }, …), listing every child to keep their order — or promote it bare and then add and bind in one flcm.editMany: [{ id: component.id, propertyDefinitions: { " +
    JSON.stringify(definition.name) + ": { type: " + JSON.stringify(definition.type) + " } } }, { id: layer, " + binding + " }].";
}

// ---- the live subject ----

// Figma's createComponentFromNode "behaves like the Create component button": handed a node it can't
// CONVERT it wraps it in a new component frame instead. That is never what the call asked for, and
// worse it is silent — so a built root and a live one both refuse the wrappable cases with this one sentence rather than
// hand back a component around the thing the agent wanted to BE the component.
const WOULD_WRAP =
  "Figma would WRAP it in a new component rather than turn it into one, so flcm refuses rather than build something you didn't ask for";

// Everything that disqualifies a new root from being promoted. A leaf — a text, a shape, a
// path, an instance — is exactly the wrappable case above, and the mismatch is silent twice over:
// the key the author put on the root would end up on the wrapper, not on the node they keyed.
// Document-blind, so judged in prepare before a single resource is loaded: a refusal costs nothing.
function assertPromotableBuiltRoot(tree: BuiltNode): void {
  if (tree.type === "FRAME") return;
  // The one non-FRAME node that builds a frame: createNodeFromSvg returns a FrameNode of vectors.
  // VECTOR (also a VECTOR) builds a real VECTOR, so it falls through to the refusal.
  if (tree.type === "VECTOR" && tree.vector?.kind === "svg") return;
  if (tree.type === "INSTANCE") {
    throw new FlcmError("authoring",
      "a component's root can't be an instance. " + WOULD_WRAP + " — author the body you want as the component " +
        "(an instance's own layers aren't editable anyway), or flcm.render it, flcm.detach the result, and promote that.",
      { path: tree.sourcePath, node: { type: tree.type, name: tree.name } },
    );
  }
  throw new FlcmError("authoring",
    "a component's root is a frame. " + WOULD_WRAP +
      " — wrap it yourself so the layout is yours: " + SUBJECT + "({ type: \"FRAME\", children: [node] }).",
    { path: tree.sourcePath, node: { type: tree.type, name: tree.name } },
  );
}

// Everything that disqualifies a LIVE node from being promoted, each named for what it is rather
// than left to Figma (whose own refusals name neither the node nor the fix — and whose INSTANCE
// behavior is not a refusal at all, but a silent wrapping).
function assertPromotable(node: any): void {
  const site = { node: { type: node.type, name: node.name, id: node.id } };
  if (isComponentDefinition(node)) {
    throw new FlcmError("authoring",
      "this is already a component — there is nothing to promote. Edit it with flcm.edit, stamp it with INSTANCE, or " +
        (node.type === "COMPONENT" ? "make it a variant with flcm.variants." : "add to the set with flcm.variants."), site,
    );
  }
  if (node.type === "INSTANCE") {
    throw new FlcmError("authoring",
      "this is an instance. " + WOULD_WRAP + " — flcm.detach it first (it becomes ordinary layers), or promote what you actually want inside it.", site,
    );
  }
  if (node.type === "SLOT") {
    throw new FlcmError("authoring", "a SLOT is a hole an instance fills, not a node of its own to promote. Promote the frame that holds the content you mean.", site);
  }
  if (node.type === "PAGE") {
    throw new FlcmError("authoring", "this is a PAGE, not a node on it — name the frame to promote (flcm.find locates it).", site);
  }
  const host = instanceAncestorOf(node);
  if (host) {
    throw new FlcmError("figma",
      "this layer is inside " + describeNodeIdentity(host) +
        ", whose child list Figma won't let a plugin change — promoting it would take it out of that list. Promote the same layer in the main component it comes from (flcm never auto-detaches).", site,
    );
  }
  // Figma's own rule, stated in createComponentFromNode's docs: the node "cannot be inside a
  // component, component set, or instance", and reaching it throws a bare "Cannot create component
  // from node" mid-write. Named here instead, because a component's sublayer is a node the
  // agent can see and address — and the fix depends on which of the two things they meant.
  const owner = editableComponentOwnerOf(node, false);
  if (owner) {
    throw new FlcmError("figma",
      "this layer is inside " + describeNodeIdentity(owner) + ", and Figma won't make a component out of a component's own sublayer. " +
        "Edit the enclosing component, or clone the sublayer out of it and promote that copy.", site,
    );
  }
}

// ---- the sealed apply ----

// Name, description, the properties, and the bindings that point at them — everything the promotion
// itself doesn't carry. Figma hands back a SUFFIXED name from addComponentProperty ("Label#12:3"),
// and that is what a reference must store, so the bindings are written from this map and never from
// the authored name.
function declareProperties(comp: any, definitions: readonly PreparedDefinition[], bound: readonly BoundLiveNode[], options: PreparedOptions): void {
  if (options.name != null) comp.name = options.name;
  if (options.description != null) comp.description = options.description;
  const suffixed: Record<string, string> = {};
  for (const definition of definitions) {
    suffixed[definition.name] = comp.addComponentProperty(definition.name, definition.figmaType, definition.defaultValue);
  }
  writeBindingReferences(bound, suffixed);
}

interface PreparedBuiltComponent {
  tree: WriteNode;
  loaded: LoadedTreeResources;
  bound: BoundWriteNode[];
  options: PreparedOptions;
}

interface GatedBuiltComponent {
  tree: WriteNode;
  /** Where the root lands: the current page for a built root, its own parent for a live one. */
  parent: any;
  place: (node: any) => void;
  resources: RenderResources;
  definitions: PreparedDefinition[];
  options: PreparedOptions;
}

export function component(specOrTarget: NodeSpec | Target, options?: ComponentOptions): Promise<AuthoredTree> {
  return enterMutatingVerb("component", async (): Promise<PreparedBuiltComponent> => {
    const prepared = compileComponentOptions(options);
    if (typeof specOrTarget !== "string" && (!specOrTarget || typeof specOrTarget !== "object" || Array.isArray(specOrTarget))) {
      throw new FlcmError("authoring",
        'the first argument must be the node to promote: a spec ({ type: "FRAME", … }, or { id, children } for a live frame) or ' + COMPONENT_TARGET_HINT +
          " — got " + JSON.stringify(specOrTarget) + ".",
      );
    }
    const spec = typeof specOrTarget === "string"
      ? { id: (await resolveTarget(specOrTarget)).id } : specOrTarget;
    const tree = compileTree(spec, "flcm.component.spec");
    const loaded = await loadTreeResources(tree);
    if (tree.liveId !== undefined) assertPromotable(loaded.live.entries.get(tree)!.node);
    else {
      assertPromotableBuiltRoot(tree);
      if (tree.layout) {
        tree.layout = foldDesignedSizeForPage(tree.layout);
        assertSizingResolvesAgainstParentFrame(tree.layout, true, SUBJECT);
      }
    }
    const bound = collectChildBindings(tree, loaded.live.entries);
    assertBindingsResolve(bound, prepared.definitions);
    assertSlotsAreBound(bound, prepared.definitions);
    return { tree, loaded, bound, options: prepared };
  }, (prepared): GatedBuiltComponent => {
    const resources = gateTreeResources(prepared.tree, prepared.loaded, SUBJECT, { componentRoot: true });
    const live = prepared.tree.liveId !== undefined ? resources.live.get(prepared.tree)! : undefined;
    if (live) assertPromotable(live.node);
    // A live root converts where it stands; a built one lands on the page as flcm.render's would.
    const parent = live ? live.node.parent! : figma.currentPage;
    const place = live ? () => {} : (node: any) => parent.appendChild(node);
    return { tree: prepared.tree, parent, place, resources,
      definitions: resolveDefaults(prepared.options.definitions, prepared.bound, resources.instances, resources.live,
        // A live root with no authored children: nothing in the call can carry a binding.
        live !== undefined && !prepared.tree.children?.length), options: prepared.options };
  }, applyBuiltComponent);
}

function applyBuiltComponent({ tree, parent, place, resources, definitions, options }: GatedBuiltComponent, span: ApplySpan): VerbResultBuilder<AuthoredTree> {
  // One of the two ctxs that opt INTO binding collection — this verb declares the properties in the
  // same call; the other is an insert landing inside a component (structure.ts's applyInsert, which
  // has one already declaring them). See RenderCtx.bindings.
  const ctx = beginRenderWalk({ ...resources, span }, { bindings: true });
  // The landing every tree-placing verb shares (render.landTree), overlap notice included. Only
  // then is there a laid-out node to convert.
  const root = landTree(parent, place, tree, ctx, SUBJECT, true);
  // The seal opens on the FRAME, before the conversion: createComponentFromNode is the likeliest
  // Figma refusal in this verb, and the frame is the identity the author authored and can act on
  // (the component it would have become doesn't exist to be named).
  const fail = beginMutatingApply(root);
  try {
    // Read before the conversion: the frame's pluginData doesn't ride across (below).
    const key = readKey(root);
    const comp = figma.createComponentFromNode(root);
    // Style links, diagnostics and warnings were queued on the frame, which no longer exists.
    retargetReplacedNode(span, root, comp);
    // The root's own key rides across by hand: createComponentFromNode returns a NEW node, so the
    // pluginData stamped on the frame belongs to a node that no longer exists. Children keep theirs:
    // Figma moves the same child nodes into the component.
    if (key) writeKey(comp, key);
    declareProperties(comp, definitions, ctx.bindings!, options);
    // options.name names the component over the name its root was built or edited with.
    if (options.name != null) supersedeObligations(comp, "name");
    recordObligations(obligationsOnTarget(deriveDeclarationObligations(options, definitions), { node: comp }, SUBJECT));
    applyExposures(ctx.exposures);
    return () => ({ ...placedTreeOf(tree.source!, ctx.placedIds), id: comp.id, type: "COMPONENT" }) as AuthoredTree;
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
    throw new FlcmError("authoring", 'must name the set: { name: "Button", description? } — got ' + JSON.stringify(raw) + ".", { path: VARIANTS_SUBJECT + ".options" });
  }
  rejectUnknownKeys(raw, VARIANTS_OPTION_KEYS, VARIANTS_SUBJECT + ".options", { reference: "components" });
  const bag = raw as Record<string, unknown>;
  if (typeof bag.name !== "string" || !bag.name.trim()) {
    throw new FlcmError("authoring",
      "must be a non-empty string — a set left unnamed takes the first member's axes as its name (\"Size=Large, State=Default\"), which is not a name anyone meant. Got " + JSON.stringify(bag.name) + ".",
      { path: VARIANTS_SUBJECT + ".options.name" },
    );
  }
  const options: VariantsOptions = { name: bag.name };
  if (bag.description != null) {
    if (typeof bag.description !== "string") {
      throw new FlcmError("authoring", "must be a string — got " + JSON.stringify(bag.description) + ".", { path: VARIANTS_SUBJECT + ".options.description" });
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
    throw new FlcmError("authoring", "a variant " + what + " is a non-empty string — got " + JSON.stringify(value) + ".", { path: at });
  }
  if (value.indexOf("=") !== -1 || value.indexOf(",") !== -1) {
    throw new FlcmError("authoring",
      "a variant " + what + " can't contain \"=\" or \",\" — Figma spells a variant's axes in its layer name (\"Size=Large, State=Default\"), so those two characters ARE the grammar. Got " + JSON.stringify(value) + ".", { path: at },
    );
  }
  return value.trim();
}

function compileVariantEntries(raw: unknown): AuthoredVariant[] {
  if (!Array.isArray(raw) || !raw.length) {
    throw new FlcmError("authoring",
      'must be a non-empty array of { component, variant }, e.g. [{ component: small, variant: { Size: "Small" } }, { component: large, variant: { Size: "Large" } }] — got ' + JSON.stringify(raw) + ".",
      { path: VARIANTS_SUBJECT + ".entries" },
    );
  }
  const axes: string[] = [];
  const combinations = new Map<string, number>();
  const out: AuthoredVariant[] = [];
  for (let i = 0; i < raw.length; i++) {
    const at = VARIANTS_SUBJECT + ".entries[" + i + "]";
    const entry = raw[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new FlcmError("authoring", "must be an object like { component, variant } — got " + JSON.stringify(entry) + ".", { path: at });
    }
    rejectUnknownKeys(entry, VARIANT_ENTRY_KEYS, at, { reference: "components" });
    const { component: target, variant } = entry as { component?: unknown; variant?: unknown };
    if (!isTargetShaped(target)) {
      throw new FlcmError("authoring", "must be " + COMPONENT_TARGET_HINT + " — got " + JSON.stringify(target) + ".", { path: at + ".component" });
    }
    if (!variant || typeof variant !== "object" || Array.isArray(variant)) {
      throw new FlcmError("authoring", 'must say which member of the set this component IS, in the set\'s axes: { Size: "Large", State: "Default" }. Got ' + JSON.stringify(variant) + ".", { path: at + ".variant" });
    }
    const rawAxes = Object.keys(variant);
    if (!rawAxes.length) throw new FlcmError("authoring", 'must name at least one axis — a set is made OF its axes, e.g. { Size: "Large" }.', { path: at + ".variant" });
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
      throw new FlcmError("authoring", "entries[" + twin + "] is " + JSON.stringify(name) + " too, and every combination in a set is unique. Give one of them a different value.", { path: at });
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
  throw new FlcmError("authoring",
    "every entry names the SAME axes (order doesn't matter). The first entry names " + quoted(axes) +
      (missing.length ? "; this one is missing " + quoted(missing) : "") +
      (extra.length ? "; this one adds " + quoted(extra) : "") + ".", { path: at },
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
  const site = { path: at, node: { type: node.type, name: node.name, id: node.id } };
  const set = variantSetOf(node);
  if (set) {
    throw new FlcmError("authoring",
      "this component is already a variant of " + describeNodeIdentity(set) +
        " — a component belongs to one set. Combine components that stand on their own, or edit the set it is in.", site,
    );
  }
  if (node.type !== "COMPONENT") {
    throw new FlcmError("authoring",
      node.type === "COMPONENT_SET"
        ? "this is a variant SET, not a component — its members are already variants. Combine standalone components instead."
        : "this is not a component. Make it one first: flcm.component(target), then combine.", site,
    );
  }
  if (node.remote) {
    throw new FlcmError("figma",
      "this component comes from a library, so this file only holds a reference to it — a set can only be built from components that live here. Combine local components instead.", site,
    );
  }
}

/**
 * flcm.variants(entries, options) — fold standalone components into a COMPONENT_SET. Each entry
 * names the SAME axes; the set lands under the FIRST component's parent, at its index, and members
 * elsewhere are moved into it. Returns the set's handle — which is what INSTANCE then takes,
 * selecting a member through `componentProperties`.
 */
// A single expression on purpose — see enterMutatingVerb on the invocation-order guarantee.
export function variants(entries: VariantEntryInput[], options: VariantsOptions): Promise<Handle> {
  return enterMutatingVerb(
    "variants",
    // Prepare — the members, resolved; and the first member's page loaded (freshness.ts on why the
    // gate proves that page is still the one the set lands on).
    async () => {
      const opts = compileVariantsOptions(options);
      const authored = compileVariantEntries(entries);
      const members: { node: any; name: string }[] = [];
      for (let i = 0; i < authored.length; i++) {
        const node: any = await resolveTarget(authored[i].component);
        const twin = members.findIndex((m) => m.node === node);
        if (twin !== -1) {
          throw new FlcmError("authoring", "entries[" + twin + "] names this component too, and one component is one variant. Drop one of the two entries.", {
            path: VARIANTS_SUBJECT + ".entries[" + i + "].component", node: { type: node.type, name: node.name, id: node.id },
          });
        }
        members.push({ node, name: authored[i].name });
      }
      const pages = createLoadedPages();
      await loadPageForWrite(members[0].node.parent, pages);
      return { members, pages, options: opts };
    },
    // Gate — every fact the set is built from, read at the seal: each member still on the canvas
    // and combinable, the first member's parent, and the set's index among the survivors.
    ({ members, pages, options: opts }): PreparedVariants => {
      members.forEach((member, i) => {
        const at = VARIANTS_SUBJECT + ".entries[" + i + "]";
        assertNodeStillOnCanvas(member.node, at);
        assertCombinable(member.node, at);
      });
      const parent = members[0].node.parent;
      if (!parent) {
        const first = members[0].node;
        throw new FlcmError("authoring", "this component has no parent for the set to land in — the set takes the first component's place. Put it on a page first.", {
          path: VARIANTS_SUBJECT + ".entries[0].component", node: { type: first.type, name: first.name, id: first.id },
        });
      }
      assertPageLoaded(parent, pages, VARIANTS_SUBJECT);
      return { members, parent, index: setIndexAmongSurvivors(members, parent), options: opts };
    },
    ({ members, parent, index, options: opts }) => {
      const fail = beginMutatingApply(members[0].node);
      try {
        // The names ARE the axes — combineAsVariants reads each member's layer name to build them.
        for (const member of members) member.node.name = member.name;
        const set: any = figma.combineAsVariants(members.map((m) => m.node), parent, index);
        set.name = opts.name;
        if (opts.description != null) set.description = opts.description;
        recordObligations(obligationsOnTarget(deriveDeclarationObligations(opts), { node: set }, VARIANTS_SUBJECT));
        return () => mintHandle(set);
      } catch (cause) {
        throw fail(cause);
      }
    },
  );
}
