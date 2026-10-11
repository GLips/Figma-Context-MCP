import type { SnapshotTokenRef } from "./snapshot.js";

/**
 * Token references — the read/write vocabulary's one spelling for "this value is a design token".
 *
 * A reference stands wherever the literal it replaces can: a paint layer or a whole paint slot,
 * a numeric layout or size word, a text style word, the effects slot, or the text style as a
 * whole. Two keys, never one: a variable binds one field, a style binds a whole slot, and Figma
 * binds them through different calls.
 */
export interface TokenIdentity {
  id: string;
  /** Present when the producer could resolve it. REST never names variables. */
  name?: string;
}

export interface VariableReference {
  variable: TokenIdentity;
}

export interface StyleReference {
  style: TokenIdentity;
}

export type TokenReference = VariableReference | StyleReference;

export function variableReference(ref: SnapshotTokenRef): VariableReference {
  return { variable: tokenIdentity(ref) };
}

export function styleReference(ref: SnapshotTokenRef): StyleReference {
  return { style: tokenIdentity(ref) };
}

// Key order is fixed (id, then name) so a reference stringifies identically whichever producer
// built it — compression and template hashing key on the serialized form.
function tokenIdentity(ref: SnapshotTokenRef): TokenIdentity {
  return ref.name === undefined ? { id: ref.id } : { id: ref.id, name: ref.name };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A read-shaped variable reference: exactly one `variable` key. Write inputs are looser; see the plugin. */
export function isVariableReference(value: unknown): value is VariableReference {
  return isPlainObject(value) && Object.keys(value).length === 1 && "variable" in value;
}

export function isStyleReference(value: unknown): value is StyleReference {
  return isPlainObject(value) && "style" in value;
}
