/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Shared by both sides of the sandbox: the preamble's egress and warning walkers, the session store, and
// the host's wire serialization (serialize.ts) must agree on which values are data to descend into. It
// lives on the preamble side because the server ships the preamble; the host imports it from here.

/**
 * Whether `value` is plain data: an array, or an object whose prototype is Object.prototype or null.
 * Decided by what the value IS, never by its fields, so an agent's own `{ id, type, removed }` is data.
 * Everything else — a live node, style or variable (each a Figma class instance), a Map — is not.
 * The prototype's prototype is compared to null, not Object.prototype, so data from another realm counts.
 */
export function isPlainData(value: unknown): value is object {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
