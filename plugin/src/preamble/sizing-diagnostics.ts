import { warnings } from "./warnings.js";
// One accumulator per synchronous mutation span. Diagnostics observe final geometry after all
// entries, overrides and percent sizing settle; they never turn a successful write into a failure.
interface SizingNode {
  id: string;
  name?: string;
  type: string;
  removed: boolean;
  visible?: boolean;
  width: number;
  height: number;
  x: number;
  y: number;
  minWidth?: number | null;
  maxWidth?: number | null;
  minHeight?: number | null;
  maxHeight?: number | null;
  parent?: SizingNode | null;
  children?: readonly SizingNode[];
  clipsContent?: boolean;
  absoluteTransform?: readonly (readonly number[])[];
  relativeTransform?: readonly (readonly number[])[];
  resize(width: number, height: number): void;
}
interface Measurement { node: SizingNode; width: number; height: number }
interface ResizeRequest { node: SizingNode; width: number; height: number }
let measured = new Map<string, Measurement>();
let affected = new Map<string, SizingNode>();
let requests = new Map<string, ResizeRequest>();
let roots = new Set<string>();
let inspectionError: unknown;

export function beginSizingDiagnostics(): void {
  measured = new Map();
  affected = new Map();
  requests = new Map();
  roots = new Set();
  inspectionError = undefined;
}

function walk(node: SizingNode, visit: (node: SizingNode) => void): void {
  if (node.removed || node.visible === false) return;
  visit(node);
  if (node.children) for (const child of node.children) walk(child, visit);
}

// `removed` answers for the node remove() was CALLED on, not for the subtree it took with it: a
// descendant of a detached node still answers false while keeping whatever geometry it held the
// moment it left the canvas. A verb that swaps a subtree out (replace) would otherwise report
// overflow inside the thing it deleted — a warning about a box no reader can see. Attachment to a
// page is the fact diagnostics actually want, so ask that instead of the flag.
function onCanvas(node: SizingNode): boolean {
  for (let n: SizingNode | null | undefined = node; n; n = n.parent) {
    if (n.removed) return false;
    if (n.type === "PAGE" || n.type === "DOCUMENT") return true;
  }
  return false;
}

export function trackSizing(node: SizingNode): void {
  try {
    // Snapshot only the containing layout tree, never the page/document. Siblings whose size changes
    // through fill/hug join the affected set after sizing settles; unchanged siblings stay out.
    let root = node;
    for (let parent = node.parent; parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT"; parent = parent.parent) root = parent;
    if (!roots.has(root.id)) walk(root, n => {
      if (!measured.has(n.id)) measured.set(n.id, { node: n, width: n.width, height: n.height });
    });
    roots.add(root.id);
    walk(node, n => affected.set(n.id, n));
    for (let parent = node.parent; parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT"; parent = parent.parent) affected.set(parent.id, parent);
  } catch (error) { inspectionError = error; }
}

export function resizeWithDiagnostics(node: SizingNode, width: number, height: number): void {
  trackSizing(node);
  node.resize(width, height);
  requests.set(node.id, { node, width, height });
}

// Project each child's own corners into the container's coordinates. Absolute transforms avoid
// the special coordinate convention of children under groups and handle rotated containers.
function overflow(container: SizingNode, child: SizingNode): { axis: "x" | "y"; amount: number } {
  const a = container.absoluteTransform, b = child.absoluteTransform;
  let transform: readonly (readonly number[])[];
  if (a && b) {
    const determinant = a[0][0] * a[1][1] - a[0][1] * a[1][0];
    if (Math.abs(determinant) < 1e-10) return { axis: "x", amount: 0 };
    const inverse = [[a[1][1] / determinant, -a[0][1] / determinant], [-a[1][0] / determinant, a[0][0] / determinant]];
    transform = inverse.map(row => [row[0] * b[0][0] + row[1] * b[1][0], row[0] * b[0][1] + row[1] * b[1][1], row[0] * (b[0][2] - a[0][2]) + row[1] * (b[1][2] - a[1][2])]);
  } else {
    transform = child.relativeTransform || [[1, 0, child.x], [0, 1, child.y]];
  }
  let xExcess = 0, yExcess = 0;
  for (const [x, y] of [[0, 0], [child.width, 0], [0, child.height], [child.width, child.height]]) {
    const cx = transform[0][0] * x + transform[0][1] * y + transform[0][2];
    const cy = transform[1][0] * x + transform[1][1] * y + transform[1][2];
    xExcess = Math.max(xExcess, -cx, cx - container.width);
    yExcess = Math.max(yExcess, -cy, cy - container.height);
  }
  return xExcess >= yExcess ? { axis: "x", amount: xExcess } : { axis: "y", amount: yExcess };
}

export function finishSizingDiagnostics(verb: string): void {
  try {
    if (inspectionError) throw inspectionError;
    for (const request of requests.values()) {
      const node = request.node;
      if (!onCanvas(node)) continue;
      for (const [axis, min, max] of [["width", "minWidth", "maxWidth"], ["height", "minHeight", "maxHeight"]] as const) {
        const requested = request[axis], actual = node[axis];
        const bound = node[min] != null && requested < node[min] ? min : node[max] != null && requested > node[max] ? max : undefined;
        if (bound && Math.abs(actual - requested) > 0.01) warnings.add({
          id: node.id, prop: axis, authored: requested, realized: actual,
          message: "flcm." + verb + ": size constrained by " + bound + " " + node[bound] + ".",
        });
      }
    }
    for (const { node, width, height } of measured.values()) {
      if (onCanvas(node) && (node.width !== width || node.height !== height)) {
        affected.set(node.id, node);
        if (node.parent && node.parent.type !== "PAGE") affected.set(node.parent.id, node.parent);
      }
    }
    for (const node of affected.values()) {
      if (!node.children || node.visible === false || !onCanvas(node)) continue;
      // A child of an on-canvas container is on the canvas by construction — visibility is the only
      // question left to ask about it.
      const offenders = node.children.filter(child => child.visible !== false)
        .map(child => ({ child, ...overflow(node, child) }))
        .filter(hit => hit.amount > 0.01).sort((a, b) => b.amount - a.amount);
      const worst = offenders[0];
      if (worst) warnings.add({
        id: null,
        message: worst.child.id + " " + JSON.stringify(worst.child.name ?? "") + " overflows " +
          node.id + " " + JSON.stringify(node.name ?? "") + " by " + Number(worst.amount.toFixed(2)) + "px on " + worst.axis +
          (offenders.length > 1 ? " and " + (offenders.length - 1) + " more" : "") +
          (node.clipsContent ? "; the parent clips, so the excess is invisible." : "; the parent does not clip, so the excess paints outside it."),
      });
    }
  } catch (error) {
    warnings.add({ id: null, message: "flcm." + verb + ": write succeeded; sizing diagnostics could not inspect the resulting layout: " + String(error) });
  } finally {
    beginSizingDiagnostics();
  }
}
