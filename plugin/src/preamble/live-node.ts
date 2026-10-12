/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Shared by both sides of the sandbox: the preamble's warning projection and the host's wire
// serialization (serialize.ts) must agree on what a live node is. It lives on the preamble side
// because the server ships the preamble; the host imports it from here.

/**
 * The one true "is this a live Figma node" test. The id+type pair alone is too loose (an agent's own
 * `{ id, type }` data object, a render Handle, or a read POJO would all trip it), so we also require
 * `removed` — present on every BaseNode, absent on plain JSON the agent builds or any POJO the read/render
 * verbs return. This single discriminator is what lets safeSerialize collapse a live node while passing
 * every agent/handle/read shape through untouched.
 */
export function looksLikeNode(
  value: unknown,
): value is { id: string; type: string; name?: unknown; removed: unknown } {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.type === "string" && "removed" in o;
}
