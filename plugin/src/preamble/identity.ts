/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// identity — who a node is and where it sits among components and instances.
//
// Its flcm key, stamped in pluginData: the render walk WRITES it (bridge.stampKey) and the target
// resolver's key scan READS it, so one home keeps write-stamp and read-scan agreeing on the string.
//
// Its topology: every "which instance / component / set is this under" question is asked here and
// answered by a named query, never by a verb walking parents itself. The queries are distinct on
// purpose — the instance above a node, the component definition a write there would change, and
// the node that holds that definition's property declarations are three different nodes.

import { Identity } from "./ir.js";
import { isSublayerId } from "@framelink/core";

// The pluginData key under which flcm stamps a node's author-chosen `key` (the one identity field write adds
// over read). Change it here and both sides move together.
const FLCM_KEY = "flcm/key";

// Read a node's flcm key (empty string when unstamped — Figma's getPluginData contract for an absent key).
export function readKey(node: { getPluginData(key: string): string }): string {
  return node.getPluginData(FLCM_KEY);
}

// Every node under `root` carrying an flcm key. Figma filters on the pluginData key natively and hands
// back only those, so a lookup costs the keyed nodes, not the tens of thousands of nodes on a large page.
export function keyedDescendants(root: { findAllWithCriteria(criteria: { pluginData: { keys: string[] } }): SceneNode[] }): SceneNode[] {
  return root.findAllWithCriteria({ pluginData: { keys: [FLCM_KEY] } });
}

// Stamp a node's flcm key.
export function writeKey(node: { setPluginData(key: string, value: string): void }, key: string): void {
  node.setPluginData(FLCM_KEY, key);
}

// A node whose ancestor chain can be walked. Structural, like everything here.
interface ParentedNode {
  type: string;
  parent?: ParentedNode | null;
}

// The nearest INSTANCE ancestor, or null, slots ignored. A naming query, not a lock test: it answers
// "which instance is this node part of" for refusals that name the instance (detach widening,
// promotion), where slot content counts too. Whether a write may land is instanceContextOf's.
// Stops at the page: an instance is always inside one.
export function instanceAncestorOf<T extends ParentedNode>(node: T): T | null {
  for (let p = node.parent; p && p.type !== "PAGE"; p = p.parent) {
    if (p.type === "INSTANCE") return p as T;
  }
  return null;
}

/** A component definition node: a COMPONENT, or the COMPONENT_SET that holds variants. */
export function isComponentDefinition(node: { type: string }): boolean {
  return node.type === "COMPONENT" || node.type === "COMPONENT_SET";
}

// The component definition a write at `node` would change, or null when there is none — including
// whenever an INSTANCE comes first, since an instance's sublayers are its component's copies and the
// definition they belong to is not this one. `countSelf`: a destination counts itself, a subject
// starts at its parent.
export function editableComponentOwnerOf<T extends ParentedNode>(node: T, countSelf: boolean): T | null {
  for (let p: ParentedNode | null | undefined = countSelf ? node : node.parent; p; p = p.parent) {
    if (p.type === "INSTANCE") return null;
    if (isComponentDefinition(p)) return p as T;
  }
  return null;
}

// The INSTANCE whose CLOSED child list `node` sits in, or null when the list is open. One rule:
// walk up, and the first SLOT or INSTANCE met decides — a SLOT means slot content, which an
// instance leaves open however deep the nesting; an INSTANCE means the component's own tree, which
// Figma closes to plugins. `countSelf` is the destination question ("may children land IN this
// node?"); a subject ("may this node move, or take a geometry write?") starts at its parent.
function closingInstanceOf<T extends ParentedNode>(node: T, countSelf: boolean): T | null {
  for (let p: ParentedNode | null | undefined = countSelf ? node : node.parent; p && p.type !== "PAGE"; p = p.parent) {
    if (p.type === "SLOT") return null;
    if (p.type === "INSTANCE") return p as T;
  }
  return null;
}

/** The node an instance context names as the owner of a lock: the instance, or its stand-in. */
export interface InstanceLockOwner<T = LockOwnerNode> {
  /** For a projected walk that reaches the definition root, the definition stands in for the instance-to-be. */
  readonly node: T;
  readonly projected: boolean;
}

interface LockOwnerNode { readonly id: string; readonly name: string; readonly type: string }

/**
 * Where a node sits among instances, as facts every write gate reads (instance-write-authorization.ts,
 * the structural gates, the pointer error, the resize backstop). Facts rather than one category:
 * the instance root is open for its own writes but closes its child list, and a SLOT is locked for
 * its own geometry but opens its child list.
 */
export interface InstanceContextFacts<T = LockOwnerNode> {
  /** "projected": judged against a component definition before the instance exists. */
  readonly basis: "live" | "projected";
  /** First SLOT/INSTANCE above the node decides: INSTANCE locks, SLOT opens. */
  readonly ownWritesLockedBy: InstanceLockOwner<T> | null;
  /** The same walk counting the node itself. */
  readonly childListClosedBy: InstanceLockOwner<T> | null;
  readonly isInstanceRoot: boolean;
}

function lockOf<T>(node: T | null, projected = false): InstanceLockOwner<T> | null {
  return node ? { node, projected } : null;
}

/** The facts for a live node where it stands. */
export function instanceContextOf<T extends ParentedNode>(node: T): InstanceContextFacts<T> {
  return {
    basis: "live",
    ownWritesLockedBy: lockOf(closingInstanceOf(node, false)),
    childListClosedBy: lockOf(closingInstanceOf(node, true)),
    isInstanceRoot: node.type === "INSTANCE",
  };
}

/**
 * The facts a node will have once appended to `parent` (built children, live-tree place, clone).
 * `parent` may be another node's facts instead: a frame the walk is still assembling sits on the
 * page until its own parent takes it, so its children inherit where IT is going, not where it is.
 * (A frame is never a SLOT or an INSTANCE whose list the walk fills, so its lock passes straight down.)
 */
export function instanceContextUnder<T extends ParentedNode>(parent: T | InstanceContextFacts<T>, node: { readonly type: string }): InstanceContextFacts<T> {
  const isInstanceRoot = node.type === "INSTANCE";
  const lock = "basis" in parent ? parent.ownWritesLockedBy : lockOf(closingInstanceOf(parent, true));
  return {
    basis: "basis" in parent ? parent.basis : "live",
    ownWritesLockedBy: lock,
    childListClosedBy: isInstanceRoot ? lockOf(node as unknown as T) : lock,
    isInstanceRoot,
  };
}

/**
 * The facts for a sublayer of a component definition, before the instance exists: what an override
 * compiled against `sublayer` will meet once it lands on the instance's copy. Walks up to
 * `definitionRoot`: the first slot hole opens, a nested INSTANCE locks, and reaching the root locks
 * (the definition standing in for the instance-to-be).
 */
export function projectedInstanceContextOf<T extends ParentedNode & { componentPropertyReferences?: Record<string, string> | null }>(
  sublayer: T, definitionRoot: T,
): InstanceContextFacts<T> {
  const walk = (start: T | null | undefined): InstanceLockOwner<T> | null => {
    for (let p = start; p; p = p.parent as T | null | undefined) {
      if (p === definitionRoot) return lockOf(definitionRoot, true);
      if (isSlotHole(p)) return null;
      if (p.type === "INSTANCE") return lockOf(p);
    }
    return lockOf(definitionRoot, true);
  };
  return {
    basis: "projected",
    ownWritesLockedBy: walk(sublayer.parent as T | null | undefined),
    childListClosedBy: walk(sublayer),
    isInstanceRoot: sublayer.type === "INSTANCE",
  };
}

// The INSTANCE whose slot holds `node`, or null when no open slot does. The walk is
// closingInstanceOf's: a SLOT met first answers with the nearest INSTANCE above it.
export function slotOwnerOf<T extends ParentedNode>(node: T, countSelf: boolean): T | null {
  let p: ParentedNode | null | undefined = countSelf ? node : node.parent;
  while (p && p.type !== "PAGE" && p.type !== "SLOT" && p.type !== "INSTANCE") p = p.parent;
  if (!p || p.type !== "SLOT") return null;
  for (p = p.parent; p && p.type !== "PAGE"; p = p.parent) if (p.type === "INSTANCE") return p as T;
  return null;
}

// Slot content that reads through its instance's path (a compound id), which Figma ties to that
// instance. Named for content a definition supplied, but not only that: once a file reloads, or in a
// native clone of a filled instance, the user's own slot content reads this way too (live,
// 2026-10-26). Content placed into a slot this session has a plain id until then.
export function isInheritedSlotContent(node: ParentedNode & { id: string }): boolean {
  return isSublayerId(node.id) && !!slotOwnerOf(node, false);
}

// The wire key a FRAME's `componentPropertyReferences` carries when it IS a slot property's frame —
// the one spelling the binding writers (component.ts), the mock, and the slot predicate below share.
export const SLOT_CONTENT_WIRE_KEY = "slotContentId";

// THE authority on "is this sublayer a slot hole" — the one place both routes into an instance's
// slot content ask. A DEFINITION shows a slot as the FRAME bound to the slot property (it keeps its
// layout and its placeholder children); every INSTANCE shows that same frame as `type: "SLOT"`. So a
// path resolved against the definition (a create, a retargeting edit) meets the frame, and one
// resolved against the live instance meets the SLOT, and both are the same hole.
export function isSlotHole(node: { type: string; componentPropertyReferences?: Record<string, string> | null }): boolean {
  if (node.type === "SLOT") return true;
  const refs = node.componentPropertyReferences;
  return node.type === "FRAME" && !!refs && Object.prototype.hasOwnProperty.call(refs, SLOT_CONTENT_WIRE_KEY) && !!refs[SLOT_CONTENT_WIRE_KEY];
}

/** The COMPONENT_SET a component is a variant of, or null for a standalone component (or any other node). */
export function variantSetOf<T extends ParentedNode>(node: T): T | null {
  return node.type === "COMPONENT" && node.parent?.type === "COMPONENT_SET" ? (node.parent as T) : null;
}

// Who holds a component's property definitions: the SET, for a variant. A variant's own
// `componentPropertyDefinitions` throws in the live API — Figma keeps a variant's properties on the
// set it belongs to — so every read and every write of them goes to this node.
export function definitionOwnerOf<T extends ParentedNode>(component: T): T {
  return variantSetOf(component) ?? component;
}

/** The owner's declarations, `{}` for a component that declares none. Pair with definitionOwnerOf. */
export function propertyDefinitionsOf(owner: { componentPropertyDefinitions?: Record<string, any> }): Record<string, any> {
  return owner.componentPropertyDefinitions || {};
}

// A node whose subtree can be walked to clear flcm keys. Structural (a live leaf simply has no
// `children`), so this module stays free of the plugin ambients like the rest of it.
interface KeyedTree {
  getPluginData(key: string): string;
  setPluginData(key: string, value: string): void;
  children?: readonly KeyedTree[];
}

// Strip the flcm key from a node and its whole subtree — what `clone` owes the document. A live
// duplicate carries the original's pluginData, so a copied key would give TWO live nodes one
// address: every later target naming it then fails loud as ambiguous (correct, but the agent is
// stuck) or, worse, is silently the wrong node if one copy is deleted. The copy is left key-LESS
// rather than re-keyed, because only the author knows what the new node should be called. ("" is
// Figma's own spelling for deleting a pluginData entry.)
export function clearKeysDeep(node: KeyedTree): void {
  if (readKey(node)) node.setPluginData(FLCM_KEY, "");
  for (const child of node.children || []) clearKeysDeep(child);
}

// The minimal live-node shape identityOf reads. Every SceneNode satisfies it; typed structurally so this
// module (and its callers in the figma-free type graph) needn't name the plugin ambients.
interface IdentifiableNode {
  id: string;
  type: string;
  name: string;
  characters?: string;
  getPluginData(key: string): string;
}

// Pull a node's stable identity — the fields render's Handle and the read verbs' SlimHandle share. ONE place
// reads name/key/text so the two consumers can't drift. `key` comes from pluginData (present only on stamped
// nodes); `text` only from TEXT nodes. Reads no geometry — the two spell it alike but source it differently
// (Handle's measured px off the live node, SlimHandle's sizing intent out of the core).
export function identityOf(node: IdentifiableNode): Identity {
  const identity: Identity = { id: node.id, type: node.type, name: node.name };
  const key = readKey(node);
  if (key) identity.key = key;
  if (node.type === "TEXT") identity.text = node.characters;
  return identity;
}
