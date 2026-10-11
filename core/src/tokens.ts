import type { SnapshotTokenRef } from "./snapshot.js";

/**
 * Token references — the read/write vocabulary's one spelling for "this value is a design token".
 *
 * A reference stands wherever the literal it replaces can: a paint layer or a whole paint slot,
 * a numeric layout or size word, a text style word, the effects slot, or the text style as a
 * whole. Two keys, never one: a variable binds one field, a style binds a whole slot, and Figma
 * binds them through different calls.
 *
 * The identity is the token's NAME — `{ variable: "color/bg" }` — whenever the producer vouches
 * that writing that name back binds this same token. Otherwise it is `{ id, name? }`: an ambiguous
 * or unreachable name, or a producer that can't name it (REST never names variables).
 */
export type TokenIdentity = string | { id: string; name?: string };

/**
 * A read carries `value`, the literal the token resolves to in the read's ordinary spelling, since
 * REST can't name variables and an agent generating code needs the hex. Writes bind by identity and
 * ignore it. A listing's paste-in reference has no value.
 */
export interface VariableReference<V = string | number> {
  variable: TokenIdentity;
  value?: V;
}

export interface StyleReference<V = unknown> {
  style: TokenIdentity;
  value?: V;
}

export type TokenReference = VariableReference | StyleReference;

export function variableReference<V extends string | number>(
  ref: SnapshotTokenRef,
  value?: V,
): VariableReference<V> {
  return withValue({ variable: tokenIdentity(ref) }, value);
}

export function styleReference<V>(ref: SnapshotTokenRef, value?: V): StyleReference<V> {
  return withValue({ style: tokenIdentity(ref) }, value);
}

// `value` always follows the identity key: compression hashes the serialized form.
function withValue<T extends object, V>(reference: T, value: V | undefined): T & { value?: V } {
  return value === undefined ? reference : { ...reference, value };
}

// Key order is fixed (id, then name) so a reference stringifies identically whichever producer
// built it — compression and template hashing key on the serialized form.
function tokenIdentity(ref: SnapshotTokenRef): TokenIdentity {
  if (ref.name !== undefined && ref.nameSuffices) return ref.name;
  return ref.name === undefined ? { id: ref.id } : { id: ref.id, name: ref.name };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A read-shaped variable reference: a `variable` key and at most its `value`. Write inputs are looser; see the plugin. */
export function isVariableReference(value: unknown): value is VariableReference {
  return (
    isPlainObject(value) &&
    "variable" in value &&
    Object.keys(value).every((key) => key === "variable" || key === "value")
  );
}

export function isStyleReference(value: unknown): value is StyleReference {
  return isPlainObject(value) && "style" in value;
}
