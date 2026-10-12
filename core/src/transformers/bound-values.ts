import type { SnapshotTokenRef } from "../snapshot.js";
import { variableReference, type VariableReference } from "../tokens.js";
import { pixelRound } from "../utils.js";

/**
 * Numeric words a variable can stand in for. A bound word emits the reference, carrying its number
 * as `value`; the snapshot keeps the literal beside the binding, which is what layout logic reads.
 */
export type BindableNumber = number | VariableReference<number>;

/** Per-side form of a four-sided word (padding, strokeWidth) once any side is bound. */
export interface BoundSides {
  top: BindableNumber;
  right: BindableNumber;
  bottom: BindableNumber;
  left: BindableNumber;
}

/** Per-corner form of `borderRadius` once any corner is bound. */
export interface BoundCorners {
  topLeft: BindableNumber;
  topRight: BindableNumber;
  bottomRight: BindableNumber;
  bottomLeft: BindableNumber;
}

/** A number, or the variable bound to it. */
export function bindNumber(literal: number, ref: SnapshotTokenRef | undefined): BindableNumber {
  const value = pixelRound(literal);
  return ref ? variableReference(ref, value) : value;
}

/**
 * Collapse a multi-part word (sides, corners) that has at least one binding: every part on ONE
 * variable reads as that variable; otherwise each part is its own literal or reference. Undefined
 * when nothing is bound, so the caller keeps its CSS shorthand string.
 *
 * A bound part is emitted even when its literal is 0 — a binding is design intent, never the
 * default the shorthand's zero-omission is about.
 */
export function bindParts<K extends string>(
  parts: ReadonlyArray<readonly [K, number, SnapshotTokenRef | undefined]>,
): VariableReference<number> | Record<K, BindableNumber> | undefined {
  const refs = parts.map(([, , ref]) => ref);
  const first = refs[0];
  if (!refs.some(Boolean)) return undefined;
  // Every part on one variable means every part holds its one value.
  if (first && refs.every((ref) => ref?.id === first.id))
    return variableReference(first, pixelRound(parts[0][1]));
  const out = {} as Record<K, BindableNumber>;
  for (const [key, literal, ref] of parts) out[key] = bindNumber(literal, ref);
  return out;
}
