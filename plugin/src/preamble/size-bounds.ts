/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { isTokenRef, type WriteLayout } from "./ir.js";
import { isVariableInput, compileVariableRef, writeBindable, unbindField, type ResolvedTokens } from "./tokens.js";
import { BOUND_WORDS } from "./vocabulary.js";
import type { AuthorizedLayout } from "./instance-write-authorization.js";

type Bounds = NonNullable<WriteLayout["bounds"]>;
type LiveBounds = Partial<Record<typeof BOUND_WORDS[number], number | null>>;

export function compileBounds(props: Partial<Record<typeof BOUND_WORDS[number], unknown>>): Bounds | undefined {
  const bounds: Bounds = {};
  for (const key of BOUND_WORDS) {
    const value = props[key];
    if (value === undefined) continue;
    if (isVariableInput(value)) { bounds[key] = compileVariableRef(value, key, "FLOAT"); continue; }
    if (value !== "none" && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
      throw new Error('flcm: ' + key + ' must be a finite positive number, { variable }, or "none" to clear it.');
    }
    bounds[key] = value;
  }
  assertBounds(bounds, {}, "flcm");
  return Object.keys(bounds).length ? bounds : undefined;
}

export function assertBounds(bounds: Bounds | undefined, live: LiveBounds, subject: string): void {
  if (!bounds) return;
  // A bound value is the variable's to decide (per mode), so it can't be ordered here; it's skipped.
  const effective = (key: typeof BOUND_WORDS[number]) => {
    const value = bounds[key];
    return value === "none" ? null : isTokenRef(value) ? null : value ?? live[key];
  };
  for (const [min, max] of [["minWidth", "maxWidth"], ["minHeight", "maxHeight"]] as const) {
    const low = effective(min), high = effective(max);
    if (low != null && high != null && low > high) {
      throw new Error(subject + ": " + min + " " + low + " exceeds " + max + " " + high + ". Change or clear the opposing bound in the same edit. Nothing was applied.");
    }
  }
}

// Takes the authorized plan, not raw words: inside an instance Figma silently ignores min/max.
export function applyBounds(node: any, layout: AuthorizedLayout, tokens: ResolvedTokens | undefined): void {
  const bounds = layout.sizing.bounds;
  if (!bounds) return;
  // Clear supplied bounds first so moving a valid interval cannot hit a transient contradiction.
  // An omitted bound is never assigned, including on an instance with its own overrides.
  for (const key of BOUND_WORDS) if (bounds[key] !== undefined) { unbindField(node, key); node[key] = null; }
  for (const key of BOUND_WORDS) {
    const value = bounds[key];
    if (value !== undefined && value !== "none") writeBindable(node, key, value, tokens);
  }
}
