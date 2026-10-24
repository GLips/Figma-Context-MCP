/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// compile-component-words — the SHAPE of the words that only the live document can resolve: an
// instance's property values, swap and override deltas, a component's property definitions under
// edit, and the binding word. Document-blind like every compiler; which names exist is the gate's.

import { keySet, WORD_GROUPS, EDIT_WORDS, BINDABLE_FIELDS, bindableFieldsOf, wordsOf } from "./vocabulary.js";
import {
  WriteProps, WriteChild, WriteType, ComponentPropertyInput, OverrideDeltaInput, ComponentPropertyBinding,
  ComponentPropertyDefinitionEdit,
} from "./ir.js";
import { length } from "./css.js";
import { rejectUnknownKeys, rejectNonDeltaWords, own, words } from "./validate.js";
import { isTargetShaped, COMPONENT_TARGET_HINT } from "./target.js";

// The authoring surface (verb Props + gradient/effects sugar) is defined ONCE in schema.ts as zod schemas
// with per-field docs; these are the z.infer'd types. Imported `import type` ONLY so schema.ts's zod is
// erased by esbuild and never reaches the sandbox bundle. Change a prop by editing the schema, not here.

// The words an override delta may name — the edit vocabulary, since an override IS an edit of one
// sublayer, judged at construction the way edit's stage 1 judges a delta. MINUS the three component
// words: a path names a sublayer, and re-pointing a NESTED instance from here would need a second
// round of path resolution against a tree this call is still deciding. Refused by name below, with
// the reachable spelling (edit the nested instance by its live id).
//
// INSTANCE_COMPONENT_WORDS is also what edit's stage 2 splits off a delta as the instance half
// (edit-plan.ts) — one set, so a word added to either group can't be split by one and refused by the other.
const INSTANCE_COMPONENT_WORDS: ReadonlySet<string> = wordsOf(["instance", "swap"]);
// The COMPONENT half of the same split: what the component DECLARES (`description`,
// `propertyDefinitions`, on a COMPONENT/COMPONENT_SET) and which property drives a SUBLAYER
// (`componentPropertyReferences`). Live-document questions all — which definition a bare name
// reaches, which component owns the node — so edit's stage 2 splits them off raw exactly as it
// splits the instance words, and component-edit.ts resolves them.
const COMPONENT_EDIT_WORDS: ReadonlySet<string> = wordsOf(["componentDefinition", "binding"]);
// Every edit word the sync compile can only judge the SHAPE of. One set, so a word added to either
// half is split by stage 2 and refused by the override gate below without a second edit.
export const DOCUMENT_RESOLVED_EDIT_WORDS: ReadonlySet<string> = keySet([...INSTANCE_COMPONENT_WORDS], [...COMPONENT_EDIT_WORDS]);
// PLUS the one word that exists only inside an override: `children` at a SLOT's path fills the
// slot. Not an edit word on any node type — a bound frame in the definition grows through
// `append`, and the SLOT node's own child list is stated whole, from the instance, or grown
// with the structural verbs. Which path is a slot is the document's to say (instance.ts).
export const SLOT_CONTENT_WORD = WORD_GROUPS.slotContent[0];
const OVERRIDE_DELTA_KEYS = keySet([...EDIT_WORDS].filter((k) => !DOCUMENT_RESOLVED_EDIT_WORDS.has(k)), WORD_GROUPS.slotContent);
// An edit entry also takes a read's `variantOptions` back, restating a set's axis as a no-op.
const PROPERTY_DEFINITION_EDIT_KEYS = keySet(WORD_GROUPS.propertyDefinition, ["variantOptions"]);
// The property bag's SHAPE: an object of names to scalars or component targets. Which names exist,
// what type each takes and which variant combinations are real are the component's to say, at
// prepare. A null value is refused here rather than treated as absence: unlike a compiler word,
// a property has no "unset" — the read never reports one as null, and a null would either
// silently keep the default or throw inside Figma's setter.
//
// `subject` is the verb that met the bag — INSTANCE at construction, flcm.edit/editMany when a
// delta carries the same word. ONE shape gate for both, so what an instance is created with and what
// an instance edit sets can't diverge on what a property value even is.
export function compileComponentPropertyBag(raw: unknown, subject: string): Record<string, ComponentPropertyInput> {
  const where = subject + ".componentProperties";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(where + ' must be an object of property values by name, e.g. { Size: "Large", Label: "Save" } — got ' + JSON.stringify(raw) + ".");
  }
  const out: Record<string, ComponentPropertyInput> = {};
  for (const name of Object.keys(raw)) {
    const value = (raw as Record<string, unknown>)[name];
    if (!name.trim()) throw new Error(where + ": a property name is empty.");
    if (typeof value === "string" || typeof value === "boolean" || isTargetShaped(value)) {
      out[name] = value as ComponentPropertyInput;
      continue;
    }
    throw new Error(
      where + "[" + JSON.stringify(name) + "]: a property value is a string (a variant option or a text), a boolean, or — for an instance-swap property — " +
        COMPONENT_TARGET_HINT + ". Got " + JSON.stringify(value) + ".",
    );
  }
  return out;
}

// The refusal's hint when a definition carries `defaultValue`, which no definition takes: the
// default is whatever its bound layer shows.
export function defaultValueHint(raw: object): string {
  return "defaultValue" in raw
    ? "A property's default is its bound layer's content (its text, visible, or instance component) — set that on the layer instead."
    : "";
}

// The edit bag's SHAPE: an object of property names to a definition object or `null`. Which names
// already exist — and therefore whether an entry adds, changes or deletes — is the component's to
// say at prepare (component-edit.ts), exactly as `componentProperties` splits the question.
//
// Names are TRIMMED here, once, for the same reason flcm.component trims them: the dedupe below, the
// live lookup, and the name Figma stores must all see one spelling.
export function compilePropertyDefinitionEditBag(raw: unknown, subject: string): Record<string, ComponentPropertyDefinitionEdit | null> {
  const where = subject + ".propertyDefinitions";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(where + ' must be an object of definitions by property name, e.g. { Label: { name: "Caption" }, Icon: null } — got ' + JSON.stringify(raw) + ".");
  }
  const out: Record<string, ComponentPropertyDefinitionEdit | null> = {};
  for (const rawName of Object.keys(raw)) {
    const name = rawName.trim();
    if (!name) throw new Error(where + ": a property name is empty.");
    if (own(out, name) !== undefined) {
      throw new Error(where + ": two entries name the property " + JSON.stringify(name) + " — one property, one entry.");
    }
    const value = (raw as Record<string, unknown>)[rawName];
    if (value !== null && (!value || typeof value !== "object" || Array.isArray(value))) {
      throw new Error(
        where + "[" + JSON.stringify(name) + "] must be a definition object — { name } to rename it, { type } to add one (bound in the same editMany), " +
          "or null to delete it. Got " + JSON.stringify(value) + ".",
      );
    }
    if (value !== null) rejectUnknownKeys(value, PROPERTY_DEFINITION_EDIT_KEYS, where + "[" + JSON.stringify(name) + "]", "prop", defaultValueHint(value));
    out[name] = value as ComponentPropertyDefinitionEdit | null;
  }
  return out;
}

// Each override is a delta in the edit vocabulary, keyed by the sublayer's component-relative path.
// The document-blind half of edit's validation runs on every entry now (a misspelled word rejects
// before any component is looked up); the per-type half — which words THIS sublayer takes, what a
// `null` means for it — runs at prepare against the resolved definition (instance.ts).
export function compileOverrideBag(raw: unknown, subject: string): Record<string, OverrideDeltaInput> {
  const where = subject + ".overrides";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(where + ' must be an object of deltas by sublayer path, e.g. { "11:9": { text: "Save" } } — got ' + JSON.stringify(raw) + ".");
  }
  const out: Record<string, OverrideDeltaInput> = {};
  for (const path of Object.keys(raw)) {
    if (!path.trim()) throw new Error(where + ": a sublayer path is empty.");
    const delta = (raw as Record<string, unknown>)[path];
    const at = where + "[" + JSON.stringify(path) + "]";
    if (delta && typeof delta === "object") {
      for (const word of Object.keys(delta)) {
        if (INSTANCE_COMPONENT_WORDS.has(word)) {
          throw new Error(
            at + ": `" + word + "` reaches a NESTED instance's own component, which an override path can't address — the path names a sublayer, and the tree behind it is what this call is still deciding. " +
              'Edit that instance directly once this call lands: flcm.edit("I<instanceId>;' + path + '", { ' + word + ": … }).",
          );
        }
        // The definition words reach the COMPONENT, and an override is a per-INSTANCE difference —
        // writing one here would change every instance, which is the opposite of what an override is.
        if (COMPONENT_EDIT_WORDS.has(word)) {
          throw new Error(
            at + ": `" + word + "` belongs to the main COMPONENT, not to one instance's override — setting it here would change every instance of it. " +
              "Edit the component itself: flcm.edit(componentId, { " + word + ": … }).",
          );
        }
      }
    }
    rejectNonDeltaWords(delta, OVERRIDE_DELTA_KEYS, at);
    if (own(delta as Record<string, unknown>, SLOT_CONTENT_WORD) !== undefined) assertSlotContentShape((delta as Record<string, unknown>)[SLOT_CONTENT_WORD], at);
    out[path] = delta as OverrideDeltaInput;
  }
  return out;
}

function assertSlotContentShape(raw: unknown, at: string): void {
  if (!Array.isArray(raw)) throw new Error(at + ".children must be an array of node specs.");
}

// ---- the BINDING word (`componentPropertyReferences`) ----
//
// Which component property drives which of this node's fields. The compiler judges SHAPE and
// per-type legality only: the names point at properties an flcm.component call declares in the same
// breath, so whether a name exists (and whether its TYPE matches the field) is that verb's prepare
// to say — the same split `componentProperties` takes.

// The per-field legality half, shared by the create bag and the edit bag so a field on the wrong
// node type reads the same either way. `what` is what the refusal calls the thing that can't bind
// it — a compiler name at create ("TEXT"), the live node's type under edit ("a TEXT").
function assertBindingFieldLegal(field: string, legal: readonly string[], where: string, what: string): void {
  if (legal.indexOf(field) !== -1) return;
  const entry: { owner?: string } | undefined = own(BINDABLE_FIELDS as Record<string, { owner?: string }>, field);
  const owner = entry?.owner;
  throw new Error(
    where + ": `" + field + "` is not one of " + what + "'s binding fields (" + legal.join(", ") + ")" +
      (owner ? " — " + owner : "") + ".",
  );
}

export function compileBindingBag(raw: unknown, legal: readonly string[], subject: string): ComponentPropertyBinding {
  const where = subject + ".componentPropertyReferences";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(where + ' must be an object naming which component property drives which field, e.g. { text: "Label" } — got ' + JSON.stringify(raw) + ".");
  }
  const out: Record<string, string> = {};
  for (const field of Object.keys(raw)) {
    const value = (raw as Record<string, unknown>)[field];
    if (value == null) continue; // an explicitly-absent field is absence, not a claim
    assertBindingFieldLegal(field, legal, where, subject);
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(where + "." + field + ": a binding names the component property that drives this field — a property name declared in the same flcm.component call. Got " + JSON.stringify(value) + ".");
    }
    // Trimmed like a definition's name (component.ts compilePropertyDefinitions), so both sides meet on one spelling.
    out[field] = value.trim();
  }
  return out as ComponentPropertyBinding;
}

/**
 * The EDIT bag's shape gate. One thing separates it from the create bag above: `null` is a CLAIM
 * here, not absence — it unbinds the field — so a null can't be skipped, and the field it names is
 * judged for legality like any other. Which property each name reaches (and whether unbinding this
 * one is legal) is prepare's, against the owning component: component-edit.ts.
 *
 * `what` names the live node's type, since under edit the offending field belongs to a node, not to
 * a compiler: "`slot` is not one of a TEXT's binding fields".
 */
export function compileBindingEditBag(raw: unknown, legal: readonly string[], subject: string, what: string): Record<string, string | null> {
  const where = subject + ".componentPropertyReferences";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(where + ' must be an object naming which component property drives which field, e.g. { text: "Label" } (or null to unbind) — got ' + JSON.stringify(raw) + ".");
  }
  const out: Record<string, string | null> = {};
  for (const field of Object.keys(raw)) {
    const value = (raw as Record<string, unknown>)[field];
    if (value === undefined) continue; // an explicitly-undefined field is absence; `null` is the unbind
    assertBindingFieldLegal(field, legal, where, what);
    if (value === null) {
      out[field] = null;
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(where + "." + field + ": a binding names the component property that drives this field — a property this component declares — or null to unbind it. Got " + JSON.stringify(value) + ".");
    }
    out[field] = value.trim();
  }
  return out;
}

// The compiler-side half: compile the bag (when named) onto the WriteNode. An empty bag lands
// nothing — a node carrying `componentPropertyReferences: {}` binds nothing and must not read as a
// bound node to flcm.component's gate.
export function compileBindings(wn: WriteProps, props: { componentPropertyReferences?: unknown }, type: WriteType): void {
  if (props.componentPropertyReferences == null) return;
  const refs = compileBindingBag(props.componentPropertyReferences, bindableFieldsOf(type), type);
  if (Object.keys(refs).length) wn.componentPropertyReferences = refs;
}

// Figma keeps ONE name for a slot: the frame's name IS the property's name, binding renames the
// frame, and renaming either side later renames both (verified live). A frame authored under one
// name and bound to a slot of another would silently lose its name, so the pair is refused instead.
// Create and insert only: under edit a frame can bind only the slot it already holds, so a `name`
// there is a rename of the slot itself, which is what Figma does with it.
export function assertSlotFrameNameAgrees(name: string | undefined, refs: ComponentPropertyBinding | undefined, subject: string): void {
  const slot = refs?.slot;
  if (slot === undefined || name === undefined || name === slot) return;
  throw new Error(
    subject + ": a slot frame's name IS its property's name — Figma keeps one name for both — so a frame named " + JSON.stringify(name) +
      " can't be bound to slot " + JSON.stringify(slot) + ". Name the property what the frame should be called, or drop `name` and the frame takes the property's.",
  );
}

/**
 * Refuse a tree carrying bindings with no declaring component behind it. A binding names a property
 * that only a component has — through render, or an append landing on a page or a plain frame, the
 * name points at nothing, and Figma would take the reference silently onto a node with no component
 * behind it. Called by every tree-taking verb except flcm.component (which mints the names), and by
 * an insert once it knows its destination is NOT inside a component (component-edit.ts).
 */
export function assertNoComponentPropertyBindings(tree: WriteChild, subject: string): void {
  if (!tree || typeof tree !== "object") return;
  if (tree.liveId !== undefined ? tree.authoring.componentPropertyReferences : tree.componentPropertyReferences) {
    throw new Error(
      subject + ": `componentPropertyReferences` binds a node to a component property, and nothing here declares one — a binding means something only with a component behind it. " +
        "Either build the component in one call (flcm.component(node, { propertyDefinitions: … }), which declares the properties the tree binds), " +
        "or insert this into a COMPONENT that already declares them (flcm.append(component, node)). To place a copy of a component, use INSTANCE.",
    );
  }
  for (const child of tree.children || []) assertNoComponentPropertyBindings(child, subject);
}

