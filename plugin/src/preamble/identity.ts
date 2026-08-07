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
