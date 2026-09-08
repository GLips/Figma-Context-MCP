// identity — a node's stable flcm identity, stamped in pluginData. The render walk WRITES it (bridge.stampKey)
// and the target resolver's key scan READS it (read.resolveTarget); giving the pluginData key and its
// accessors one home is what keeps write-stamp and read-scan from disagreeing on the string.

import { Identity } from "./ir.js";

// The pluginData key under which flcm stamps a node's author-chosen `key` (the one identity field write adds
// over read). Change it here and both sides move together.
export const FLCM_KEY = "flcm/key";

// Read a node's flcm key (empty string when unstamped — Figma's getPluginData contract for an absent key).
export function readKey(node: { getPluginData(key: string): string }): string {
  return node.getPluginData(FLCM_KEY);
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

// The nearest INSTANCE ancestor, or null. Figma restricts what may change on an instance's
// children — some props can't be overridden, and the tree shape can't change at all — and the fix
// is always "edit the component it comes from", so the structural gates and the mutating-verb
// error walk the same chain. Stops at the page: an instance is always inside one.
export function instanceAncestorOf<T extends ParentedNode>(node: T): T | null {
  for (let p = node.parent; p && p.type !== "PAGE"; p = p.parent) {
    if (p.type === "INSTANCE") return p as T;
  }
  return null;
}

// The INSTANCE whose CLOSED child list `node` sits in, or null when the list is open. One rule:
// walk up, and the first SLOT or INSTANCE met decides — a SLOT means slot content, which an
// instance leaves open however deep the nesting; an INSTANCE means the component's own tree, which
// Figma closes to plugins. `countSelf` is the destination question ("may children land IN this
// node?"): the node itself decides first, so a SLOT destination is open and an INSTANCE destination
// closed. A subject ("may this node move or go?") starts at its parent — an instance is an ordinary
// node in ITS parent, and the SLOT node is itself a sublayer whose parent chain meets the instance.
export function childListClosingInstanceOf<T extends ParentedNode>(node: T, countSelf: boolean): T | null {
  for (let p: ParentedNode | null | undefined = countSelf ? node : node.parent; p && p.type !== "PAGE"; p = p.parent) {
    if (p.type === "SLOT") return null;
    if (p.type === "INSTANCE") return p as T;
  }
  return null;
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

// Who holds a component's property definitions: the SET, for a variant. A variant's own
// `componentPropertyDefinitions` throws in the live API — Figma keeps a variant's properties on the
// set it belongs to — so every read and every write of them goes to this node.
export function definitionOwnerOf<T extends ParentedNode>(component: T): T {
  return component.parent && component.parent.type === "COMPONENT_SET" ? (component.parent as T) : component;
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
// The one-line spelling every refusal names a node by: `TEXT "Label" (id "12:3")`.
export function describeNodeIdentity(node: { type: string; name: string; id: string }): string {
  return node.type + " " + JSON.stringify(node.name) + " (id " + JSON.stringify(node.id) + ")";
}

export function identityOf(node: IdentifiableNode): Identity {
  const identity: Identity = { id: node.id, type: node.type, name: node.name };
  const key = readKey(node);
  if (key) identity.key = key;
  if (node.type === "TEXT") identity.text = node.characters;
  return identity;
}
