/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Host-side wire serialization for the sandbox eval result and its console output. This is TS HOST code
// (bundled into code.ts's IIFE), NOT sandbox-preamble source — it runs on the plugin main thread and never
// touches figma.*, so it stays a pure, unit-testable module distinct from the host's messaging and approval.
// What a read looks like on the way out is the preamble's policy (preamble/egress.ts), applied first.
//
// The bridge JSON-serializes every outbound message, and a live Figma node is NOT plain JSON (sending one
// yields opaque failures). So the return path does two things here: guardReturnValue REJECTS a returned live
// node up front (loud, teaching the id pattern), and safeSerialize is the belt-and-suspenders that collapses
// any live node the guard let through (notably a logged node) to a stable { id, name, type }. Everything
// else — a render Handle, a read POJO, an agent's own data — round-trips WHOLE.

import { looksLikeNode } from "./preamble/live-node.js";
import { FlcmError } from "./preamble/flcm-error.js";

function findLiveNode(value: unknown, path: string, seen: Set<object>): { path: string; type: string } | null {
  if (value === null || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  // Stop at a node — never recurse into its (huge, circular) internals.
  if (looksLikeNode(value)) return { path, type: value.type };
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findLiveNode(value[i], `${path}[${i}]`, seen);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of Object.keys(value as object)) {
    const hit = findLiveNode((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key, seen);
    if (hit) return hit;
  }
  return null;
}

/**
 * Reject a return value that is — or contains — a live node, loudly. The bridge JSON-serializes
 * everything, so a node would come back as a bare { id } with every other property dropped and no signal
 * that it happened. Better a clear error that teaches the id pattern than silent loss the agent debugs blind.
 */
export function guardReturnValue(value: unknown): void {
  const hit = findLiveNode(value, "", new Set());
  if (!hit) return;
  const where = hit.path ? ` (at return value ${hit.path.startsWith("[") ? hit.path : `.${hit.path}`})` : "";
  throw new FlcmError(
    "authoring",
    `You returned a live Figma node${where}: a ${hit.type}. Live nodes can't cross the bridge — ` +
      `they collapse to { id } and you lose every other property. Return the id string instead: ` +
      "`return node.id` (or `return { id: node.id }`, or an array of ids).",
  );
}

/** Serialize whole values. Ancestors detect cycles without corrupting shared references. */
export function safeSerialize(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return value.toString();

  // A live Figma node collapses to a stable handle the agent can thread into later execute_code calls via
  // figma.getNodeByIdAsync. Gated on the removed-carrying discriminator, NOT a bare id+type shape, so a render
  // Handle / SlimHandle / read POJO (which carry id+type but no `removed`) falls through and round-trips whole.
  if (looksLikeNode(value)) {
    return {
      id: value.id,
      name: typeof value.name === "string" ? value.name : undefined,
      type: value.type,
    };
  }

  if (ancestors.has(value)) throw new FlcmError("authoring", "Cannot serialize cyclic return or console data.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => safeSerialize(item, ancestors));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeSerialize(item, ancestors)]));
  } finally { ancestors.delete(value); }
}
