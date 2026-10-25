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
// One walk per value, and one question to Figma per object that could be a node. A node is Figma's
// live object, not data: on the console it collapses to { id, name, type } as it was when logged, a
// handle the agent can thread by id; on the result it is refused, loudly, teaching the id pattern.
// A node the agent removed is still a node and is treated the same: refused on the result, collapsed
// on the console. Everything else — a render Handle, a read POJO, an agent's own data, whatever its
// fields — round-trips WHOLE.

import { isNodeIdShaped } from "@framelink/core";
import { isPlainData } from "./preamble/plain-data.js";
import type { EgressChannel } from "./preamble/egress.js";
import { FlcmError } from "./preamble/flcm-error.js";

/**
 * Whether Figma holds `value` itself as the node at `value.id`. Figma hands back the identical object
 * for a live node, and that identity is the only sure test: no field or prototype tells a node apart.
 */
export type IsFigmaNode = (value: { id: string }) => Promise<boolean>;

type NodeCandidate = { id: string } & Record<string, unknown>;
type NodeIdentity = { id: string; name: string | undefined; type: unknown };

// Figma is asked only about an object that could be a node. Plain data never is, and getNodeByIdAsync
// stalls ~10s and then throws on an id that is not node-shaped (a style's, a variable's).
function isNodeCandidate(value: object): value is NodeCandidate {
  if (isPlainData(value)) return false;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && isNodeIdShaped(id);
}

// The agent's own value contains itself; only it can break the cycle.
const CYCLIC_VALUE_REFUSAL = "a value your code returned or logged contains itself (a cycle), so it can't be sent back. " +
  "Return or log a copy without the cycle, such as just the ids you need.";

/**
 * An object that may be a node, as it was when it was snapshotted: its identity is read and Figma is
 * asked then, so a node renamed or removed afterwards still reports what was logged.
 */
class PendingNodeCandidate {
  readonly identity: NodeIdentity;
  readonly isNode: Promise<boolean>;

  constructor(readonly candidate: NodeCandidate, readonly isFigmaNode: IsFigmaNode) {
    this.identity = { id: candidate.id, name: typeof candidate.name === "string" ? candidate.name : undefined, type: candidate.type };
    // Figma answers null for a removed node, yet the object is still the one Figma made, and its own
    // `removed` says so. Read after the answer, so a node removed while Figma was asked counts too.
    this.isNode = isFigmaNode(candidate).then((held) => held || candidate.removed === true);
  }
}

declare const wireSnapshotBrand: unique symbol;
/** A value serialized when it was taken, its possible nodes still awaiting Figma's answer. */
export type WireSnapshot = { readonly [wireSnapshotBrand]: true };

function snapshotTree(value: unknown, isFigmaNode: IsFigmaNode, ancestors: Set<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return value.toString();
  if (typeof value !== "object") return value;
  // Not descended now: a live node's internals are huge and circular.
  if (isNodeCandidate(value)) return new PendingNodeCandidate(value, isFigmaNode);

  return snapshotContents(value, isFigmaNode, ancestors);
}

function snapshotContents(value: object, isFigmaNode: IsFigmaNode, ancestors: Set<object>): unknown {
  if (ancestors.has(value)) throw new FlcmError("authoring", CYCLIC_VALUE_REFUSAL);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => snapshotTree(item, isFigmaNode, ancestors));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotTree(item, isFigmaNode, ancestors)]));
  } finally { ancestors.delete(value); }
}

/**
 * Serialize a value as it is NOW, synchronously, so a logged value the agent mutates afterwards still
 * reports what was logged. Shared references stay whole; a cycle is refused here.
 */
export function snapshotForWire(value: unknown, isFigmaNode: IsFigmaNode): WireSnapshot {
  return snapshotTree(value, isFigmaNode, new Set()) as WireSnapshot;
}

// A returned node is refused rather than collapsed as on the console: the result is the agent's data,
// read back as what the call produced, and a node there is almost always the live object returned for
// its properties, of which a handle would silently keep three.
function refuseReturnedNode({ id, name, type }: NodeIdentity, path: string): FlcmError {
  return new FlcmError(
    "authoring",
    "your code returned a live Figma node, which can't be sent back: it is Figma's object, not data, and none of its " +
      "properties would come with it. Return the id string instead: `return node.id` (or `return { id: node.id }`, or an array of ids).",
    { path: "return value" + (path === "" ? "" : path.startsWith("[") ? path : "." + path), node: { id, name, type: String(type) } },
  );
}

const childPath = (path: string, key: string | number): string =>
  typeof key === "number" ? `${path}[${key}]` : path ? `${path}.${key}` : key;

// `disowned` holds the candidates Figma disowned on the way down, which is how a cycle through one is caught.
async function resolveTree(tree: unknown, channel: EgressChannel, path: string, disowned: ReadonlySet<object>): Promise<unknown> {
  if (tree instanceof PendingNodeCandidate) {
    const { candidate, identity, isFigmaNode } = tree;
    if (disowned.has(candidate)) throw new FlcmError("authoring", CYCLIC_VALUE_REFUSAL);
    if (await tree.isNode) {
      if (channel === "result") throw refuseReturnedNode(identity, path);
      return identity;
    }
    // Figma disowns it, so it is data like any other object: its own enumerable entries.
    const contents = snapshotContents(candidate, isFigmaNode, new Set());
    return resolveTree(contents, channel, path, new Set(disowned).add(candidate));
  }
  if (Array.isArray(tree)) return Promise.all(tree.map((item, i) => resolveTree(item, channel, childPath(path, i), disowned)));
  if (tree === null || typeof tree !== "object") return tree;
  const entries = await Promise.all(
    Object.entries(tree).map(async ([key, item]) => [key, await resolveTree(item, channel, childPath(path, key), disowned)] as const),
  );
  return Object.fromEntries(entries);
}

/**
 * The wire form of a snapshot on `channel`: a node is refused on the result and collapses to
 * { id, name, type } on the console. Rejects on a cycle through an object Figma disowned, the one
 * cycle a snapshot can't see.
 */
export function resolveWireSnapshot(snapshot: WireSnapshot, channel: EgressChannel): Promise<unknown> {
  return resolveTree(snapshot, channel, "", new Set());
}

/** The wire form of `value` on `channel`, snapshotted and resolved in one step. */
export function serializeForWire(value: unknown, isFigmaNode: IsFigmaNode, channel: EgressChannel): Promise<unknown> {
  return resolveWireSnapshot(snapshotForWire(value, isFigmaNode), channel);
}
