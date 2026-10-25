/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Host-side wire serialization for the sandbox eval result and its console output. This is TS HOST code
// (bundled into code.ts's IIFE), NOT sandbox-preamble source — it runs on the plugin main thread and asks
// Figma only through the IsFigmaNode it is handed, so it stays a pure, unit-testable module distinct from
// the host's messaging and approval. What a read looks like on the way out is the preamble's policy
// (preamble/egress.ts), applied first.
//
// The bridge JSON-serializes every outbound message, and a live Figma node is NOT plain JSON (it arrives
// as a bare { id }). So guardReturnValue REJECTS a returned live node up front (loud, teaching the id
// pattern), and a logged one collapses to a stable { id, name, type }. Everything else — a render
// Handle, a read POJO, an agent's own data, whatever its fields — round-trips WHOLE.

import { isNodeIdShaped } from "@framelink/core";
import { isPlainData } from "./preamble/plain-data.js";
import { FlcmError, type FlcmErrorNode } from "./preamble/flcm-error.js";

/**
 * Whether Figma holds `value` itself as the node at `value.id`. Figma hands back the identical object
 * for a live node, and that identity is the only sure test: no field or prototype tells a node apart.
 */
export type IsFigmaNode = (value: { id: string }) => Promise<boolean>;

type NodeCandidate = { id: string } & Record<string, unknown>;

// Figma is asked only about an object that could be a node. Plain data never is, and getNodeByIdAsync
// stalls ~10s and then throws on an id that is not node-shaped (a style's, a variable's).
function isNodeCandidate(value: object): value is NodeCandidate {
  if (isPlainData(value)) return false;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && isNodeIdShaped(id);
}

function nodeIdentity(node: NodeCandidate): { id: string; name: string | undefined; type: unknown } {
  return { id: node.id, name: typeof node.name === "string" ? node.name : undefined, type: node.type };
}

// Every object that could be a node, in path order. A candidate is descended into too: one Figma
// disowns is data, and may hold a node.
function nodeCandidates(value: unknown, path: string, seen: Set<object>, found: { path: string; candidate: NodeCandidate }[]): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (isNodeCandidate(value)) found.push({ path, candidate: value });
  if (Array.isArray(value)) {
    value.forEach((item, i) => nodeCandidates(item, `${path}[${i}]`, seen, found));
    return;
  }
  for (const key of Object.keys(value)) nodeCandidates((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key, seen, found);
}

/**
 * Reject a return value that is — or contains — a live node, loudly. The bridge JSON-serializes
 * everything, so a node would come back as a bare { id } with every other property dropped and no signal
 * that it happened. Better a clear error that teaches the id pattern than silent loss the agent debugs blind.
 */
export async function guardReturnValue(value: unknown, isFigmaNode: IsFigmaNode): Promise<void> {
  const found: { path: string; candidate: NodeCandidate }[] = [];
  nodeCandidates(value, "", new Set(), found);
  for (const { path, candidate } of found) {
    if (!(await isFigmaNode(candidate))) continue;
    const { id, name, type } = nodeIdentity(candidate);
    const node: FlcmErrorNode = { id, name, type: String(type) };
    throw new FlcmError(
      "authoring",
      "your code returned a live Figma node, which can't be sent back: it would arrive as a bare { id } with every other " +
        "property lost. Return the id string instead: `return node.id` (or `return { id: node.id }`, or an array of ids).",
      { path: "return value" + (path === "" ? "" : path.startsWith("[") ? path : "." + path), node },
    );
  }
}

// The agent's own value contains itself; only it can break the cycle.
const CYCLIC_VALUE_REFUSAL = "a value your code returned or logged contains itself (a cycle), so it can't be sent back. " +
  "Return or log a copy without the cycle, such as just the ids you need.";

// An object that may be a live node, held by reference until Figma says whether it is.
class PendingNodeCandidate {
  constructor(readonly candidate: NodeCandidate) {}
}

declare const wireSnapshotBrand: unique symbol;
/** A value serialized when it was logged, its possible live nodes still awaiting Figma's answer. */
export type WireSnapshot = { readonly [wireSnapshotBrand]: true };

function snapshotTree(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return value.toString();
  if (typeof value !== "object") return value;
  // Not descended now: a live node's internals are huge and circular.
  if (isNodeCandidate(value)) return new PendingNodeCandidate(value);

  return snapshotContents(value, ancestors);
}

function snapshotContents(value: object, ancestors: Set<object>): unknown {
  if (ancestors.has(value)) throw new FlcmError("authoring", CYCLIC_VALUE_REFUSAL);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => snapshotTree(item, ancestors));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotTree(item, ancestors)]));
  } finally { ancestors.delete(value); }
}

/**
 * Serialize a value as it is NOW, synchronously, so a logged value the agent mutates afterwards still
 * reports what was logged. Shared references stay whole; a cycle is refused here.
 */
export function snapshotForWire(value: unknown): WireSnapshot {
  return snapshotTree(value, new Set()) as WireSnapshot;
}

// `disowned` holds the candidates Figma disowned on the way down, which is how a cycle through one is caught.
async function resolveTree(tree: unknown, isFigmaNode: IsFigmaNode, disowned: ReadonlySet<object>): Promise<unknown> {
  if (tree instanceof PendingNodeCandidate) {
    const { candidate } = tree;
    if (disowned.has(candidate)) throw new FlcmError("authoring", CYCLIC_VALUE_REFUSAL);
    // A live node collapses to a stable handle the agent can thread into later calls by id.
    if (await isFigmaNode(candidate)) return nodeIdentity(candidate);
    // Figma disowns it, so it is data like any other object: its own enumerable entries.
    return resolveTree(snapshotContents(candidate, new Set()), isFigmaNode, new Set(disowned).add(candidate));
  }
  if (Array.isArray(tree)) return Promise.all(tree.map(item => resolveTree(item, isFigmaNode, disowned)));
  if (tree === null || typeof tree !== "object") return tree;
  const entries = await Promise.all(
    Object.entries(tree).map(async ([key, item]) => [key, await resolveTree(item, isFigmaNode, disowned)] as const),
  );
  return Object.fromEntries(entries);
}

/**
 * The wire form of a snapshot: every pending object Figma confirms as a live node becomes { id, name, type }.
 * Rejects on a cycle through an object Figma disowned, the one cycle a snapshot can't see.
 */
export function resolveWireSnapshot(snapshot: WireSnapshot, isFigmaNode: IsFigmaNode): Promise<unknown> {
  return resolveTree(snapshot, isFigmaNode, new Set());
}

/** Serialize whole values. Ancestors detect cycles without corrupting shared references. */
export function serializeForWire(value: unknown, isFigmaNode: IsFigmaNode): Promise<unknown> {
  return resolveWireSnapshot(snapshotForWire(value), isFigmaNode);
}
