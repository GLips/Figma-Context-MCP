// identity — a node's stable flcm identity, stamped in pluginData. The render walk WRITES it (bridge.stampKey)
// and the target resolver's key scan READS it (read.resolveTarget); giving the pluginData key and its
// accessors one home is what keeps write-stamp and read-scan from disagreeing on the string.

// The pluginData key under which flcm stamps a node's author-chosen `key` (the one identity field write adds
// over read). Change it here and both sides move together.
export const FLCM_KEY = "flcm/key";

// Read a node's flcm key (empty string when unstamped — Figma's getPluginData contract for an absent key).
export function readKey(node: BaseNode): string {
  return node.getPluginData(FLCM_KEY);
}

// Stamp a node's flcm key.
export function writeKey(node: BaseNode, key: string): void {
  node.setPluginData(FLCM_KEY, key);
}
