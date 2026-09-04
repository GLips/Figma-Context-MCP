import type { SnapshotPoint, SnapshotRect, SnapshotSize } from "~/core/snapshot.js";

/**
 * Own-box recovery — a node's authored size and origin, solved from its AABB.
 *
 * The REST wire carries neither `size` nor `relativeTransform`: `@figma/rest-api-spec`
 * marks both "Only present if `geometry=paths` is passed", and we don't pass it —
 * verified live 2026-09-04, where adding it grew a small subtree's response from
 * 9KB to 142KB of vector path data. So the size a rotated node was authored at has
 * to be inverted out of `absoluteBoundingBox`, the page-space axis-aligned box.
 * The plugin producer has no such problem: it reads `node.width`/`x` directly.
 */

/**
 * The parent space a node's own box is resolved against: the accumulated
 * page-space rotation of the ancestor chain, and the parent's own top-left corner
 * on the page (absent when the parent's solve failed, or at the top of the payload
 * where there is no parent).
 *
 * "Space" and not "frame" on purpose — `frame` means the Figma FRAME node type
 * everywhere else in this codebase.
 */
export interface RestParentSpace {
  /** Degrees, counterclockwise-positive — the sum of this node's ancestors' rotations. */
  pageRotation: number;
  originOnPage?: SnapshotPoint;
}

/**
 * The space the payload's top-level nodes are resolved in. Rotation is assumed
 * zero: an ancestor ABOVE the requested root can't be seen in the response, so a
 * rotated one would throw off every descendant's solve. Rare enough to accept —
 * and unknowable from the payload either way.
 */
export const ROOT_SPACE: RestParentSpace = { pageRotation: 0 };

/**
 * How ill-conditioned the inversion may get before we refuse to answer.
 *
 * The system's determinant is `cos 2θ`, which vanishes at every odd multiple of
 * 45°: there W = H = (w+h)/√2, two equations collapse into one, and a 60x20, a
 * 20x60 and a 40x40 all produce the identical square AABB. The split simply is not
 * in the payload. Error is amplified by `1/|det|`, so we bail at 0.0105 = `|cos 2θ|`
 * at θ = 45° ± 0.3° — already a 95x amplification at the edge, and ~286x a tenth of
 * a degree further in. Roughly 0.6% of the angle space, but it contains 45° itself,
 * a popular authored angle; there the caller falls back to the AABB (pinned as a
 * REST-only divergence in tests/parity/shared-subset.ts).
 */
const DEGENERATE_DETERMINANT = 0.0105;

/**
 * How negative a solved side may be before we treat it as a broken solve rather
 * than a zero one.
 *
 * A zero side is real and common — every Figma LINE is 0 tall — but it does not
 * arrive as a clean zero. `h = (H·c − W·s)/det` computes `w·s·c` and `w·c·s` as
 * separate products of an already-rounded AABB, so the cancellation leaves a
 * signed residual bounded by the AABB's own precision times the `1/|det|`
 * amplification — measured at up to 1.8e-5 px for an 80px box at float32, and
 * scaling with the box. A bare `>= 0` test therefore rejects a real zero side at
 * 209 of the 355 non-degenerate whole-degree angles, and the caller then reports
 * the LINE's rotated shadow — the exact bug this module exists to fix. 1e-4 of the
 * AABB's longest side clears that residual by ~400x while still landing two orders
 * of magnitude below the 0.005 px `pixelRound` can even represent.
 *
 * Past the tolerance the solve is genuinely broken (skew, which this formula only
 * approximates) and we return null rather than clamp a real negative to zero.
 */
const NEGATIVE_SIDE_TOLERANCE_RATIO = 1e-4;

/**
 * How close to a half-turn a rotation must be for a reflection to be the likelier
 * reading — see the mirroring note on `solveOwnBox`. Tight on purpose: Figma's
 * `atan2` reports a horizontal flip as exactly 180°.
 */
const HALF_TURN_TOLERANCE_DEG = 0.01;

/** The node's own box: its authored size, and its own top-left corner in page space. */
export interface OwnBox {
  size: SnapshotSize;
  /**
   * Absent when the reported rotation is a half-turn, which a horizontal flip
   * forges — the size survives, only the corner is unknowable. See `solveOwnBox`.
   */
  originOnPage?: SnapshotPoint;
}

/**
 * Invert a page-space AABB back into the node that cast it.
 *
 * A node of size w x h rotated by θ has an AABB of
 *   `W = w·c + h·s`, `H = w·s + h·c`   (c = |cos θ|, s = |sin θ|)
 * so with `det = c² − s²` (= `cos 2θ`) the size falls out as
 *   `w = (W·c − H·s)/det`, `h = (H·c − W·s)/det`.
 *
 * The origin follows from Figma's transform `[[cos θ, sin θ, x], [−sin θ, cos θ, y]]`:
 * the AABB's min corner is the node's origin plus whichever corner offsets are
 * negative, so subtracting those recovers the origin.
 *
 * `θ` must be the node's PAGE rotation (its own plus every ancestor's), because the
 * AABB is page-axis-aligned. Returns null when the size is unusable — no box, the
 * degenerate band, or a meaningfully negative side.
 *
 * MIRRORING. `rotation` is `atan2(-m10, m00)`, which cannot tell a rotation from a
 * reflection, and the payload doesn't carry the transform's determinant — so a
 * mirrored node is undeterminable here rather than unhandled. The SIZE is immune
 * (a reflection preserves both AABB extents, and |cos|/|sin| are the same either
 * way), so only the corner is at stake, and only two readings collide in practice:
 * a VERTICAL flip reports 0°, where this formula already returns the AABB corner
 * and so agrees with the pre-inversion answer; a HORIZONTAL flip reports 180°,
 * where it would move the corner by the node's own height. Since a half-turn buys
 * nothing for the size (at 180° the AABB extents ARE the own size) and Shift+H is
 * far commoner than an exact half-turn, we withhold the origin there instead of
 * guessing. A flip COMBINED with a rotation (which reads as θ−180°) still slips
 * through; see parity pin 7.
 */
export function solveOwnBox(
  box: SnapshotRect | null | undefined,
  pageRotationDeg: number,
): OwnBox | null {
  if (!box) return null;

  const theta = (pageRotationDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const c = Math.abs(cos);
  const s = Math.abs(sin);
  const det = c * c - s * s;
  if (Math.abs(det) < DEGENERATE_DETERMINANT) return null;

  const solvedWidth = (box.width * c - box.height * s) / det;
  const solvedHeight = (box.height * c - box.width * s) / det;
  const tolerance = NEGATIVE_SIDE_TOLERANCE_RATIO * Math.max(box.width, box.height);
  if (!(solvedWidth >= -tolerance) || !(solvedHeight >= -tolerance)) return null;

  const width = Math.max(0, solvedWidth);
  const height = Math.max(0, solvedHeight);
  const size = { width, height };
  if (isHalfTurn(pageRotationDeg)) return { size };

  return {
    size,
    originOnPage: {
      x: box.x - Math.min(0, width * cos) - Math.min(0, height * sin),
      y: box.y - Math.min(0, -width * sin) - Math.min(0, height * cos),
    },
  };
}

function isHalfTurn(degrees: number): boolean {
  const wrapped = Math.abs(((degrees % 360) + 360) % 360);
  return Math.abs(wrapped - 180) < HALF_TURN_TOLERANCE_DEG;
}

/**
 * Express a page-space point in the parent's space — the spelling `node.x`/`node.y`
 * has in the plugin API. Undoing the parent's page rotation is what keeps the two
 * producers agreeing when a rotated node sits inside a rotated one.
 */
export function toParentSpacePoint(
  pointOnPage: SnapshotPoint,
  parent: Required<RestParentSpace>,
): SnapshotPoint {
  const dx = pointOnPage.x - parent.originOnPage.x;
  const dy = pointOnPage.y - parent.originOnPage.y;
  const theta = (parent.pageRotation * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}
