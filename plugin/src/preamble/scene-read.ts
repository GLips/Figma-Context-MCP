/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
/**
 * The plugin producer's one composed read: scene nodes in, the core's full simplify result out,
 * with every precondition the core leaves to its producer met here — off-tree component
 * definitions, the placement context of a targeted node, comment counts on-node.
 *
 * Its document lookups arrive as arguments, so this module never touches the `figma` global: the
 * read verbs pass live lookups, and the REST↔plugin parity harness passes a fixture's.
 */
import { offTreeComponentIds, simplify, type SimplifyResult } from "@framelink/core";
import type { NodeSnapshot } from "@framelink/core/snapshot";
import {
  sceneNodeToSnapshot,
  scenePlacement,
  type MainComponentSink,
  type SceneNodeLike,
  type SceneTokenResolver,
  type UnreadableSink,
} from "./node-to-snapshot.js";

/** Unresolved comment threads per node id — the `comments: n` on read results. */
export type CommentCounts = ReadonlyMap<string, number>;

export interface SceneReadOptions {
  /** The roots' live parent, for a read that keeps the sizing and position they have as its children. */
  parent?: SceneNodeLike;
  resolveToken: SceneTokenResolver;
  annotationCategories: ReadonlyMap<string, string>;
  /** Collects the ids the walk had to omit; the caller reports them. */
  unreadable?: UnreadableSink;
  comments?: CommentCounts;
}

/** Every root read together, as siblings: one component catalog, one compression pass. */
export async function readSceneDesign(
  roots: readonly SceneNodeLike[],
  { parent, resolveToken, annotationCategories, unreadable, comments }: SceneReadOptions,
): Promise<SimplifyResult> {
  const mainComponents: MainComponentSink = new Map();
  const snapshots: NodeSnapshot[] = [];
  for (const root of roots) {
    snapshots.push(
      await sceneNodeToSnapshot(root, resolveToken, mainComponents, annotationCategories, unreadable, parent),
    );
  }
  const componentDefinitions = await offTreeDefinitions(
    snapshots,
    mainComponents,
    annotationCategories,
    resolveToken,
  );
  if (comments?.size) for (const snapshot of snapshots) attachCommentCounts(snapshot, comments);
  return simplify(snapshots, {
    componentDefinitions,
    placement: parent && scenePlacement(parent),
  });
}

/**
 * The real definition for every component this subtree instantiates but doesn't contain.
 *
 * Free here in a way it never is over REST: the snapshot walk ALREADY resolved every instance's
 * main component (that is where `componentId` comes from), so `mainComponents` is that work handed
 * back rather than repeated. Published library components included — no key lookup, no second
 * file, no permission that can be missing. So the scope is the whole runtime read, hidden layers
 * included, and a fetched definition's own nested components are followed in turn.
 *
 * Supplementary by definition, so it never fails the read: a component that refuses to snapshot
 * costs its own entry a donated body, nothing more.
 */
async function offTreeDefinitions(
  snapshots: NodeSnapshot[],
  mainComponents: MainComponentSink,
  annotationCategories: ReadonlyMap<string, string>,
  resolveToken: SceneTokenResolver,
): Promise<NodeSnapshot[]> {
  const definitions: NodeSnapshot[] = [];
  const attempted = new Set<string>();
  for (;;) {
    const wanted = offTreeComponentIds([...snapshots, ...definitions], { read: "runtime" })
      .filter((id) => !attempted.has(id));
    if (wanted.length === 0) return definitions;
    for (const id of wanted) {
      attempted.add(id);
      const main = mainComponents.get(id);
      if (!main) continue;
      try {
        definitions.push(
          await sceneNodeToSnapshot(
            main as unknown as SceneNodeLike,
            resolveToken,
            mainComponents,
            annotationCategories,
          ),
        );
      } catch {
        // The component was deleted mid-read, or the library refused to load it. Donor floor.
      }
    }
  }
}

function attachCommentCounts(snapshot: NodeSnapshot, counts: CommentCounts): void {
  const count = counts.get(snapshot.id);
  if (count) snapshot.comments = count;
  for (const child of snapshot.children ?? []) attachCommentCounts(child, counts);
}
