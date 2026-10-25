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
// One walk per value, and one question to Figma per object that could be a node, however often the
// value references it. A node is Figma's live object, not data: on the console it collapses to its
// identity as it was when logged, a handle the agent can thread by id; on the result it is refused,
// loudly, teaching the id pattern. Everything else — a render Handle, a read POJO, an agent's own
// data, whatever its fields — round-trips WHOLE.

import { isPlainData } from "./preamble/plain-data.js";
import type { EgressChannel } from "./preamble/egress.js";
import { FlcmError } from "./preamble/flcm-error.js";

/**
 * Whether `value` is a node Figma made: asked once of each object that could be one, and whose answer
 * alone decides. The plugin's (run-executor.ts) is Figma's own identity at `value.id`, or `removed`.
 */
export type IsFigmaNode = (value: { readonly id: string; readonly removed?: unknown }) => Promise<boolean>;

type NodeCandidate = { id: string } & Record<string, unknown>;
/**
 * What a node collapses to on the console, read when it is snapshotted. A removed node is named by id
 * alone: Figma destroys some (the frame createComponentFromNode replaces), and those throw on every
 * read but `id` and `removed`, so Figma's documented rule — check `removed` first — holds here.
 */
type NodeIdentity = { id: string; name: string | undefined; type: unknown } | { id: string; removed: true };

function readNodeIdentity(candidate: NodeCandidate): NodeIdentity {
  if (candidate.removed === true) return { id: candidate.id, removed: true };
  return { id: candidate.id, name: typeof candidate.name === "string" ? candidate.name : undefined, type: candidate.type };
}

// Figma is asked only about an object that could be a node: plain data never is. Which candidates
// are worth a lookup at all is the IsFigmaNode's to know.
function isNodeCandidate(value: object): value is NodeCandidate {
  return !isPlainData(value) && typeof (value as { id?: unknown }).id === "string";
}

// The agent's own value contains itself; only it can break the cycle.
const CYCLIC_VALUE_REFUSAL = "a value your code returned or logged contains itself (a cycle), so it can't be sent back. " +
  "Return or log a copy without the cycle, such as just the ids you need.";

/**
 * An object that may be a node: its identity is read and Figma is asked when it is snapshotted, so a
 * node renamed or removed afterwards still reports what was logged. Only its identity is kept: one
 * Figma disowns is data whose fields are read when it resolves, as they are then.
 */
class PendingNodeCandidate {
  readonly identity: NodeIdentity;
  readonly isNode: Promise<boolean>;

  constructor(readonly candidate: NodeCandidate, readonly figma: FigmaAsked) {
    this.identity = readNodeIdentity(candidate);
    this.isNode = figma.isFigmaNode(candidate);
  }
}

/** One serialization's question to Figma, and the candidate already asked about each object. */
type FigmaAsked = { isFigmaNode: IsFigmaNode; asked: Map<object, PendingNodeCandidate> };

function pendingCandidate(candidate: NodeCandidate, figma: FigmaAsked): PendingNodeCandidate {
  let pending = figma.asked.get(candidate);
  if (!pending) figma.asked.set(candidate, (pending = new PendingNodeCandidate(candidate, figma)));
  return pending;
}

declare const wireSnapshotBrand: unique symbol;
/** A value serialized when it was taken, its possible nodes still awaiting Figma's answer. */
export type WireSnapshot = { readonly [wireSnapshotBrand]: true };

function snapshotTree(value: unknown, figma: FigmaAsked, ancestors: Set<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return value.toString();
  if (typeof value !== "object") return value;
  // Not descended now: a live node's internals are huge and circular.
  if (isNodeCandidate(value)) return pendingCandidate(value, figma);

  return snapshotContents(value, figma, ancestors);
}

function snapshotContents(value: object, figma: FigmaAsked, ancestors: Set<object>): unknown {
  if (ancestors.has(value)) throw new FlcmError("authoring", CYCLIC_VALUE_REFUSAL);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => snapshotTree(item, figma, ancestors));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotTree(item, figma, ancestors)]));
  } finally { ancestors.delete(value); }
}

/**
 * Serialize a value as it is NOW, synchronously, so a logged value the agent mutates afterwards still
 * reports what was logged. Shared references stay whole; a cycle is refused here.
 */
export function snapshotForWire(value: unknown, isFigmaNode: IsFigmaNode): WireSnapshot {
  return snapshotTree(value, { isFigmaNode, asked: new Map() }, new Set()) as WireSnapshot;
}

// A returned node is refused rather than collapsed as on the console: the result is the agent's data,
// read back as what the call produced, and a node there is almost always the live object returned for
// its properties, of which a handle would silently keep three.
function refuseReturnedNode(identity: NodeIdentity, path: string): FlcmError {
  return new FlcmError(
    "authoring",
    "your code returned a live Figma node, which can't be sent back: it is Figma's object, not data, and none of its " +
      "properties would come with it. Return the id string instead: `return node.id` (or `return { id: node.id }`, or an array of ids).",
    {
      path: "return value" + (path === "" ? "" : path.startsWith("[") ? path : "." + path),
      // A removed node's type can't be read; the message names it "removed node (id …)".
      node: "removed" in identity ? { id: identity.id, type: "removed node" } : { id: identity.id, name: identity.name, type: String(identity.type) },
    },
  );
}

const childPath = (path: string, key: string | number): string =>
  typeof key === "number" ? `${path}[${key}]` : path ? `${path}.${key}` : key;

// `disowned` holds the candidates Figma disowned on the way down, which is how a cycle through one is caught.
// Resolved in path order, so a refusal names the first node; the snapshot's questions are already in flight.
async function resolveTree(tree: unknown, channel: EgressChannel, path: string, disowned: ReadonlySet<object>): Promise<unknown> {
  if (tree instanceof PendingNodeCandidate) {
    const { candidate, identity, figma } = tree;
    if (disowned.has(candidate)) throw new FlcmError("authoring", CYCLIC_VALUE_REFUSAL);
    if (await tree.isNode) {
      if (channel === "result") throw refuseReturnedNode(identity, path);
      return identity;
    }
    // Figma disowns it, so it is data like any other object: its own enumerable entries.
    const contents = snapshotContents(candidate, figma, new Set());
    return resolveTree(contents, channel, path, new Set(disowned).add(candidate));
  }
  if (Array.isArray(tree)) {
    const items: unknown[] = [];
    for (const [i, item] of tree.entries()) items.push(await resolveTree(item, channel, childPath(path, i), disowned));
    return items;
  }
  if (tree === null || typeof tree !== "object") return tree;
  const entries: [string, unknown][] = [];
  for (const [key, item] of Object.entries(tree)) entries.push([key, await resolveTree(item, channel, childPath(path, key), disowned)]);
  return Object.fromEntries(entries);
}

/**
 * The wire form of a snapshot on `channel`: a node is refused on the result and collapses to
 * { id, name, type } on the console, or { id, removed: true } if it was removed when snapshotted.
 * Rejects on a cycle through an object Figma disowned, the one cycle a snapshot can't see.
 */
export function resolveWireSnapshot(snapshot: WireSnapshot, channel: EgressChannel): Promise<unknown> {
  return resolveTree(snapshot, channel, "", new Set());
}

/** The wire form of `value` on `channel`, snapshotted and resolved in one step. */
export function serializeForWire(value: unknown, isFigmaNode: IsFigmaNode, channel: EgressChannel): Promise<unknown> {
  return resolveWireSnapshot(snapshotForWire(value, isFigmaNode), channel);
}
