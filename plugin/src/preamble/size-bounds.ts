import type { WriteLayout } from "./ir.js";

export const BOUND_KEYS = ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const;
type Bounds = NonNullable<WriteLayout["bounds"]>;
type LiveBounds = Partial<Record<typeof BOUND_KEYS[number], number | null>>;

export function compileBounds(props: Bounds): Bounds | undefined {
  const bounds: Bounds = {};
  for (const key of BOUND_KEYS) {
    const value = props[key];
    if (value === undefined) continue;
    if (value !== "none" && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
      throw new Error('flcm: ' + key + ' must be a finite positive number or "none" to clear it.');
    }
    bounds[key] = value;
  }
  assertBounds(bounds, {}, "flcm");
  return Object.keys(bounds).length ? bounds : undefined;
}

export function assertBounds(bounds: Bounds | undefined, live: LiveBounds, subject: string): void {
  if (!bounds) return;
  const effective = (key: typeof BOUND_KEYS[number]) => bounds[key] === "none" ? null : bounds[key] ?? live[key];
  for (const [min, max] of [["minWidth", "maxWidth"], ["minHeight", "maxHeight"]] as const) {
    const low = effective(min), high = effective(max);
    if (low != null && high != null && low > high) {
      throw new Error(subject + ": " + min + " " + low + " exceeds " + max + " " + high + ". Change or clear the opposing bound in the same edit. Nothing was applied.");
    }
  }
}

export function applyBounds(node: LiveBounds, bounds: Bounds): void {
  // Clear supplied bounds first so moving a valid interval cannot hit a transient contradiction.
  // An omitted bound is never assigned, including on an instance with its own overrides.
  for (const key of BOUND_KEYS) if (bounds[key] !== undefined) node[key] = null;
  for (const key of BOUND_KEYS) {
    const value = bounds[key];
    if (typeof value === "number") node[key] = value;
  }
}
