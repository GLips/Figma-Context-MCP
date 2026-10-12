/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// target — the grammar every verb addresses a node by (a bare string: id or flcm/key; flcm.id(id);
// anything carrying an `id`, like a handle) and its one resolver. Read and write verbs both come
// here, so an id or key can't resolve differently depending on which verb named it.

import { sceneFigma as figma, invalidateSceneAccess } from "./scene-access.js";
import type { Target, RawIdRef } from "./ir.js";
import { readKey } from "./identity.js";
import { assertNodeStillOnCanvas } from "./freshness.js";
import { isReadableSceneNode } from "./scene-readability.js";

// Whether a value has a target's shape — the one predicate every verb that tells a target apart from
// another argument (instance specs, swaps, component/variants subjects, clone's props-or-parent)
// asks, so they refuse the same non-targets with the same sentence.
export function isTargetShaped(value: unknown): value is Target {
  if (typeof value === "string") return value.trim().length > 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as { __flcmId?: unknown; id?: unknown };
  return typeof v.__flcmId === "string" || typeof v.id === "string";
}

export const COMPONENT_TARGET_HINT = "a component's node id (a read's `componentId`), an flcm/key, flcm.id(id), or a handle from flcm.find";

// Component target syntax is shared by new instances and swaps; prepare resolves live identity.
export function compileSwapTarget(raw: unknown, subject: string): Target {
  if (!isTargetShaped(raw)) {
    throw new Error(subject + ".componentId: the component to swap to must be " + COMPONENT_TARGET_HINT + " — got " + JSON.stringify(raw) + ".");
  }
  return raw;
}

// flcm.id(id) — the target escape hatch. Wraps a raw node id so a target-taking verb (get/find/edit) treats
// it as a live-node id and never scans it as an flcm/key (the one string a bare target could be read either
// way). resolveTarget unwraps it structurally, never via this function.
export function id(nodeId: unknown): RawIdRef {
  if (typeof nodeId !== "string" || !nodeId.trim()) {
    throw new Error('flcm.id: expected a node id string, e.g. flcm.id("12:34") — got ' + JSON.stringify(nodeId) + ".");
  }
  return { __flcmId: nodeId };
}

// A pluginData scan searches this. Default is the current page; a verb's `within` narrows it (resolved by the
// same shape rules). PageNode and any container SceneNode both satisfy this.
export type ScanRoot = (PageNode | SceneNode) & ChildrenMixin;

function isRawIdRef(value: unknown): value is RawIdRef {
  return !!value && typeof value === "object" && typeof (value as RawIdRef).__flcmId === "string";
}

// Anything carrying a string `id` — a render Handle, a slim handle, a read POJO. Its `id` is a live-node id.
function hasId(value: unknown): value is { id: string } {
  return !!value && typeof value === "object" && typeof (value as { id: string }).id === "string";
}

// getNodeByIdAsync, treating a removed node as absent (the live API already returns null for removed; the
// guard keeps the mock and any stale reference honest). Async because the manifest declares
// `documentAccess: dynamic-page` — the sync getNodeById throws under it — which is what makes every
// target-taking verb below async. Cast to SceneNode — every resolvable target is one in practice, and the
// read/edit verbs that consume this operate on scene nodes.
async function byId(id: string): Promise<SceneNode | null> {
  const node = await figma.getNodeByIdAsync(id);
  return node && !node.removed ? node as SceneNode : null;
}

function scanKey(key: string, root: ScanRoot): SceneNode[] {
  return root.findAllWithCriteria({ types: [] }).filter((n) => isReadableSceneNode(n) && readKey(n) === key);
}

// Resolve a target to a live node, or throw. `within` scopes the key scan (default: current page); it is
// itself a target, resolved by the same rules, so `within: 'card'` searches inside the node keyed "card".
export async function resolveTarget(target: Target, within?: Target): Promise<SceneNode> {
  invalidateSceneAccess();
  if (isRawIdRef(target)) {
    const node = await byId(target.__flcmId);
    if (!node) throw new Error(`flcm: no live node with id ${JSON.stringify(target.__flcmId)} (flcm.id(...)).`);
    return node;
  }
  if (typeof target === "string") return resolveString(target, within);
  if (hasId(target)) {
    const node = await byId(target.id);
    if (!node) throw new Error(`flcm: no live node with id ${JSON.stringify(target.id)} — it may have been deleted.`);
    return node;
  }
  throw new Error(`flcm: cannot resolve target ${JSON.stringify(target)} — pass a node id, an flcm/key, flcm.id(id), or a handle.`);
}

// A bare string is resolved by what actually EXISTS, not by guessing from its shape: try it as a live id and
// as an flcm/key, then resolve by the single match. Checking both is what makes the pathological
// id-that-is-also-a-key case fail loud instead of silently picking one. (Common paths — a handle or
// flcm.id(...) — skip the key scan entirely; only a bare string pays it.)
async function resolveString(target: string, within?: Target): Promise<SceneNode> {
  if (!target.trim()) {
    throw new Error("flcm: empty target — pass a node id, an flcm/key, flcm.id(id), or a handle.");
  }
  const root = await resolveScanRoot(within);
  const byIdNode = await byId(target);
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

/**
 * Targets resolved AHEAD of a verb's seal, handed to its sync phase as a lookup.
 *
 * Resolution is the one document read that has to be async under `dynamic-page` (getNodeByIdAsync,
 * page loads), and a mutating verb decides nothing about the document until the synchronous
 * stretch right before its seal (mutation-lock.ts). So a verb resolves every target its input
 * names — a component, a swap value, a definition's default — in prepare, and its gate asks this
 * for the node. A resolution that FAILED is kept as its error and thrown from the gate, so a bad
 * id refuses with the message it always had, from the phase every refusal comes from.
 *
 * `node` never returns a removed node: the gate reads the document as it stands at the seal, and a
 * node deleted during the resource loads is gone from it.
 */
export interface ResolvedTargets {
  resolve(target: Target): Promise<void>;
  /** Sync. Throws the resolution's own error, or a freshness refusal for a target prepare never asked for. */
  node(target: Target, subject: string): SceneNode;
}

// The cache key is the target's FORM plus its value: a bare string is resolved by a different rule
// (id or key, both checked) than the same string wrapped in flcm.id(), so they are different asks.
function targetCacheKey(target: Target): string {
  if (typeof target === "string") return "s:" + target;
  if (isRawIdRef(target)) return "r:" + target.__flcmId;
  if (hasId(target)) return "h:" + target.id;
  return "?:" + JSON.stringify(target);
}

export function createResolvedTargets(): ResolvedTargets {
  const entries = new Map<string, { node: SceneNode } | { error: unknown }>();
  return {
    async resolve(target) {
      const key = targetCacheKey(target);
      if (entries.has(key)) return;
      try {
        entries.set(key, { node: await resolveTarget(target) });
      } catch (error) {
        entries.set(key, { error });
      }
    },
    node(target, subject) {
      const entry = entries.get(targetCacheKey(target));
      // Prepare decides WHICH values are targets from the document as it stood then (a property's
      // declared type, a definition's). A miss here means that decision no longer holds at the seal.
      if (!entry) {
        throw new Error(
          subject + ": " + JSON.stringify(target) + " was not resolved before this call's seal — the definitions it depends on changed while the call was loading fonts and images. Nothing was applied; re-run the call.",
        );
      }
      if ("error" in entry) throw entry.error;
      assertNodeStillOnCanvas(entry.node, subject);
      return entry.node;
    },
  };
}

export async function resolveScanRoot(within: Target | undefined): Promise<ScanRoot> {
  if (within == null) return figma.currentPage;
  const node = await resolveTarget(within);
  if (!("findAll" in node)) {
    throw new Error(`flcm: \`within\` target resolved to a ${node.type} with no children to search — pass a container (frame/group/section) or a page.`);
  }
  return node;
}
