import type { NodeSnapshot } from "@framelink/core/snapshot";

/**
 * The REST↔plugin diff one layer below parity's output comparison: the two adapters' decoded
 * `NodeSnapshot`s, field by field. Output parity can't see a divergence the core happens to
 * flatten (a field it doesn't read today); this sees every one, and each must match a named entry
 * of `SNAPSHOT_DIVERGENCES` or fail.
 */

/** One field where the two decodes disagree. `node` is the snapshot node the field belongs to. */
export interface SnapshotDifference {
  path: string;
  key: string;
  rest: unknown;
  scene: unknown;
  node: Partial<NodeSnapshot>;
}

/** Every number within this of its counterpart is the same measurement. */
const NUMERIC_TOLERANCE = 1e-4;

/**
 * The divergences the adapters are allowed, by name. A new disagreement fails the diff until it is
 * fixed or named here, and an entry nothing exercises fails too, so the list can't rot.
 */
export const SNAPSHOT_DIVERGENCES: Record<string, (d: SnapshotDifference) => boolean> = {
  // The plugin reads float32 values off the live node; REST inverts boxes out of a page-space AABB.
  // Both land within float noise of the authored number.
  numericPrecision: ({ rest, scene }) =>
    typeof rest === "number" &&
    typeof scene === "number" &&
    Math.abs(rest - scene) <= NUMERIC_TOLERANCE * Math.max(1, Math.abs(rest)),
  // REST withholds an own box it can't solve — a root has no parent space to solve it in, and some
  // rotations defeat the inversion (shared-subset.ts pin 7). The plugin reads it off the node.
  withheldOwnBox: ({ key, rest }) =>
    (key === "ownSize" || key === "ownOrigin") && rest === undefined,
  // A paragraph with no list: REST sends empty per-line arrays, the plugin one entry per line.
  unlistedParagraph: ({ key, rest, scene }) =>
    Array.isArray(rest) &&
    rest.length === 0 &&
    Array.isArray(scene) &&
    ((key === "lineTypes" && scene.every((type) => type === "NONE")) ||
      (key === "lineIndentations" && scene.every((indent) => indent === 0))),
  // The plugin's text segments each carry their fills, so the base run does; REST's base style
  // has none (the node's own fills paint it).
  baseRunFills: ({ path, key, rest }) =>
    path.endsWith(".text.style") && key === "fills" && rest === undefined,
  // Pin 1: the plugin API has no gif handle at all.
  gifRef: ({ key, scene }) => key === "gifRef" && scene === undefined,
  // Defaults REST omits and the plugin states: an image filter at 0, a paint at full opacity.
  statedDefaults: ({ path, key, rest, scene }) =>
    rest === undefined &&
    ((path.endsWith(".filters") && scene === 0) || (key === "opacity" && scene === 1)),
  // Pin 3: REST can't name a variable (Enterprise-only endpoint), so it can't vouch for a name.
  tokenNames: ({ path, key, rest }) =>
    (key === "name" || key === "nameSuffices") &&
    rest === undefined &&
    /(boundVariables|Variable|\.styles)\b/.test(path),
  // Figma's REST API reports a GROUP's clipsContent as false; a plugin GroupNode has no such field.
  groupClipsContent: ({ key, node, rest, scene }) =>
    key === "clipsContent" && node.type === "GROUP" && rest === false && scene === undefined,
  // The plugin names the styled-segments field a text override touched; REST lists characters only.
  overrideFields: ({ key, path, rest, scene }) =>
    path.includes(".overrides.") &&
    key === "fields" &&
    Array.isArray(rest) &&
    Array.isArray(scene) &&
    scene.filter((field) => !rest.includes(field)).every((field) => field === "styledTextSegments"),
};

/** Every field where the decodes disagree, each tagged with the divergence that allows it, if any. */
export function diffSnapshots(
  rest: readonly NodeSnapshot[],
  scene: readonly NodeSnapshot[],
): Array<SnapshotDifference & { allowedBy?: string }> {
  const out: Array<SnapshotDifference & { allowedBy?: string }> = [];
  const visit = (
    a: unknown,
    b: unknown,
    path: string,
    key: string,
    node: Partial<NodeSnapshot>,
  ) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    const comparable =
      a !== null &&
      b !== null &&
      typeof a === "object" &&
      typeof b === "object" &&
      Array.isArray(a) === Array.isArray(b) &&
      !(Array.isArray(a) && Array.isArray(b) && a.length !== b.length);
    if (comparable) {
      const here = `${path}.${key}`;
      const isNode = (value: object) => "id" in value && "type" in value;
      for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const nextA = (a as Record<string, unknown>)[field];
        const nextB = (b as Record<string, unknown>)[field];
        const owner =
          nextA && typeof nextA === "object" && isNode(nextA) && key === "children"
            ? (nextA as Partial<NodeSnapshot>)
            : node;
        visit(nextA, nextB, here, field, owner);
      }
      return;
    }
    const difference = { path, key, rest: a, scene: b, node };
    const allowedBy = Object.entries(SNAPSHOT_DIVERGENCES).find(([, allows]) =>
      allows(difference),
    )?.[0];
    out.push({ ...difference, allowedBy });
  };
  // JSON round-trip: a field present-but-undefined and an absent one are the same snapshot.
  const plain = (value: readonly NodeSnapshot[]) => JSON.parse(JSON.stringify(value)) as unknown;
  visit(plain(rest), plain(scene), "", "children", {});
  return out;
}
