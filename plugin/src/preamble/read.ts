// read — the read-side walk that speaks figma.* (the counterpart to bridge.ts's write walk). Phase 1 seeds
// it with target resolution; the read walk + sceneNodeToSnapshot join it as the read verbs (get/find) land.
//
// resolveTarget is the ONE place a `target` becomes a live node, shared by every target-taking verb so they
// can't drift on how a string/id/key/handle resolves. It is uniform and FAIL-LOUD: not-found and ambiguous
// both throw, naming the target and (for a key clash) the count — a blind agent must never silently act on
// the wrong node.

import { Target, RawIdRef } from "./ir.js";
import { readKey } from "./identity.js";

// A pluginData scan searches this. Default is the current page; a verb's `within` narrows it (resolved by the
// same shape rules). PageNode and any container SceneNode both satisfy this.
type ScanRoot = BaseNode & ChildrenMixin;

function isRawIdRef(value: unknown): value is RawIdRef {
  return !!value && typeof value === "object" && typeof (value as RawIdRef).__flcmId === "string";
}

// Anything carrying a string `id` — a render Handle, a slim handle, a read POJO. Its `id` is a live-node id.
function hasId(value: unknown): value is { id: string } {
  return !!value && typeof value === "object" && typeof (value as { id: string }).id === "string";
}

// getNodeById, treating a removed node as absent (live getNodeById already returns null for removed; the
// guard keeps the mock and any stale reference honest). Cast to SceneNode — every resolvable target is one
// in practice, and the read/edit verbs that consume this operate on scene nodes.
function byId(id: string): SceneNode | null {
  const node = figma.getNodeById(id);
  return node && !node.removed ? (node as SceneNode) : null;
}

function scanKey(key: string, root: ScanRoot): SceneNode[] {
  return root.findAll((n) => readKey(n) === key);
}

// Resolve a target to a live node, or throw. `within` scopes the key scan (default: current page); it is
// itself a target, resolved by the same rules, so `within: 'card'` searches inside the node keyed "card".
export function resolveTarget(target: Target, within?: Target): SceneNode {
  if (isRawIdRef(target)) {
    const node = byId(target.__flcmId);
    if (!node) throw new Error(`flcm: no live node with id ${JSON.stringify(target.__flcmId)} (flcm.id(...)).`);
    return node;
  }
  if (typeof target === "string") return resolveString(target, within);
  if (hasId(target)) {
    const node = byId(target.id);
    if (!node) throw new Error(`flcm: the handle's node (id ${JSON.stringify(target.id)}) no longer exists — it may have been deleted.`);
    return node;
  }
  throw new Error(`flcm: cannot resolve target ${JSON.stringify(target)} — pass a node id, an flcm/key, flcm.id(id), or a handle.`);
}

// A bare string is resolved by what actually EXISTS, not by guessing from its shape: try it as a live id and
// as an flcm/key, then resolve by the single match. Checking both is what makes the pathological
// id-that-is-also-a-key case fail loud instead of silently picking one. (Common paths — a handle or
// flcm.id(...) — skip the key scan entirely; only a bare string pays it.)
function resolveString(target: string, within?: Target): SceneNode {
  if (!target.trim()) {
    throw new Error("flcm: empty target — pass a node id, an flcm/key, flcm.id(id), or a handle.");
  }
  const root = scanRoot(within);
  const byIdNode = byId(target);
  const byKey = scanKey(target, root);

  if (byIdNode && byKey.length) {
    throw new Error(
      `flcm: target ${JSON.stringify(target)} is ambiguous — it matches BOTH a live node id and ${byKey.length} node(s) with the flcm/key ${JSON.stringify(target)}. ` +
        `Use flcm.id(${JSON.stringify(target)}) to force the id, or rename the key.`,
    );
  }
  if (byIdNode) return byIdNode;
  if (byKey.length === 1) return byKey[0];
  if (byKey.length > 1) {
    throw new Error(
      `flcm: target ${JSON.stringify(target)} is ambiguous — ${byKey.length} nodes carry the flcm/key ${JSON.stringify(target)}. ` +
        `Keys must be unique; scope with \`within\`, or address a specific node by id or flcm.id(...).`,
    );
  }
  throw new Error(
    `flcm: no node found for target ${JSON.stringify(target)} — no live node has that id, and no node carries it as an flcm/key on the searched root.`,
  );
}

function scanRoot(within: Target | undefined): ScanRoot {
  if (within == null) return figma.currentPage;
  const node = resolveTarget(within);
  if (!("findAll" in node)) {
    throw new Error(`flcm: \`within\` target resolved to a ${node.type} with no children to search — pass a container (frame/group/section) or a page.`);
  }
  return node as ScanRoot;
}
