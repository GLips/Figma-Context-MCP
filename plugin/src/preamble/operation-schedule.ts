/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// operation-schedule — the order one call's writes land in, per operation rather than per entry.
// An operation is one phase of one layer's write. The phases below are the order they land in on
// one layer: a container's mode before its children's placement, own sizing before the cover that
// reads it, every px size before the percents and ratios that read the parent.
//
// Across layers the call's own dependencies decide. A write runs before every operation whose
// words it can move (geometry-dependency.ts: an ancestor's resize before a descendant's left, a
// percent before the stretched child's width), a main component's edit before every operation on a
// layer that inherits from it, a release before every write and a definition before every binding.
// Ties keep the phase-major order, then the caller's. A cycle is refused with zero writes; anything
// the order still misses the finalizer catches and rolls back.

import { isSublayerId } from "@framelink/core";
import { sceneFigma as figma } from "./scene-access.js";
import { FlcmError } from "./flcm-error.js";
import { effectKey, reachedGeometry, type GeometryEffect, type GeometryProjection } from "./geometry-dependency.js";

const EDIT_OPERATION_PHASES = [
  "binding-release", "retarget", "definitions", "vector-path", "appearance", "text", "container", "placement",
  "own-size", "cover", "constraints", "bound-defaults", "binding", "after-binding", "slot-content",
  "percent-size", "aspect-ratio", "text-clamp", "percent-position",
] as const;

export type EditOperationPhase = (typeof EDIT_OPERATION_PHASES)[number];

/** One operation, by the entry, layer and phase that name it. */
export interface OperationRef { readonly entry: number; readonly layer: string; readonly phase: EditOperationPhase }

const RANK = new Map<EditOperationPhase, number>(EDIT_OPERATION_PHASES.map((phase, i) => [phase, i]));

/** One phase of one layer's write, as the scheduler orders it. */
export interface EditOperation {
  /** Its entry's place in the call: the tie-break among operations free to run together. */
  readonly entry: number;
  readonly phase: EditOperationPhase;
  /** The layer it writes, by id (a sublayer the call re-acquires, by the id it will have): one layer's operations run in phase order. */
  readonly layer: string;
  readonly writes: readonly GeometryEffect[];
  /** What its written words measure: every write that can move one of these runs first. */
  readonly reads: readonly GeometryEffect[];
  /** The components whose definition it edits, and the ones its layer inherits from, by id. */
  readonly defines: ReadonlySet<string>;
  readonly inherits: ReadonlySet<string>;
  /**
   * Operations of other layers that land first whatever the geometry says: an instance's retarget
   * before its overrides, the attach that puts a live tree's node where its words land.
   */
  readonly waitsFor?: readonly OperationRef[];
  /** How a refusal names it: `[0] "Card" width`. */
  readonly label: string;
}

// Phases every operation of another phase waits on, call-wide: no write lands on a property a field
// is leaving, and a binding names a property its definition already minted.
const BARRIERS: readonly { readonly first: EditOperationPhase; readonly then: (phase: EditOperationPhase) => boolean }[] = [
  { first: "binding-release", then: (phase) => phase !== "binding-release" },
  { first: "definitions", then: (phase) => phase === "binding" || phase === "bound-defaults" },
];

/**
 * `operations` in the order they land, or a refusal naming the words that depend on each other in
 * a cycle. Built at the gate, so a refusal leaves zero writes.
 */
export function scheduleEditOperations<Op extends EditOperation>(operations: readonly Op[], subject: string, projection: GeometryProjection = {}): Op[] {
  const n = operations.length;
  const after: Set<number>[] = operations.map(() => new Set());
  const edge = (from: number, to: number) => { if (from !== to) after[from].add(to); };

  const byLayer = new Map<string, number[]>();
  operations.forEach((op, i) => byLayer.set(op.layer, [...(byLayer.get(op.layer) ?? []), i]));
  for (const ids of byLayer.values()) {
    ids.sort((a, b) => compare(operations, a, b));
    for (let k = 1; k < ids.length; k++) edge(ids[k - 1], ids[k]);
  }
  for (const { first, then } of BARRIERS) {
    const firsts = operations.flatMap((op, i) => (op.phase === first ? [i] : []));
    if (firsts.length) operations.forEach((op, j) => { if (then(op.phase)) for (const i of firsts) edge(i, j); });
  }
  operations.forEach((op, j) => {
    for (const first of op.waitsFor ?? []) {
      operations.forEach((other, i) => { if (other.entry === first.entry && other.layer === first.layer && other.phase === first.phase) edge(i, j); });
    }
  });
  operations.forEach((definer, i) => {
    if (!definer.defines.size) return;
    operations.forEach((dependent, j) => {
      if (dependent.layer !== definer.layer && [...dependent.inherits].some((id) => definer.defines.has(id))) edge(i, j);
    });
  });
  const reaching = new Map<string, number[]>();
  operations.forEach((op, i) => {
    if (!op.writes.length) return;
    for (const key of reachedGeometry(op.writes, projection).keys()) reaching.set(key, [...(reaching.get(key) ?? []), i]);
  });
  operations.forEach((op, j) => {
    for (const read of op.reads) for (const i of reaching.get(effectKey(read)) ?? []) if (operations[i].layer !== op.layer) edge(i, j);
  });

  const waiting = operations.map(() => 0);
  for (const targets of after) for (const j of targets) waiting[j]++;
  const ready = operations.flatMap((_, i) => (waiting[i] ? [] : [i]));
  const order: Op[] = [];
  while (ready.length) {
    let best = 0;
    for (let k = 1; k < ready.length; k++) if (compare(operations, ready[k], ready[best]) < 0) best = k;
    const [i] = ready.splice(best, 1);
    order.push(operations[i]);
    for (const j of after[i]) if (--waiting[j] === 0) ready.push(j);
  }
  if (order.length < n) throw new FlcmError("authoring", describeCycle(operations, after, waiting), { call: subject });
  return order;
}

function compare(operations: readonly EditOperation[], a: number, b: number): number {
  const x = operations[a], y = operations[b];
  return RANK.get(x.phase)! - RANK.get(y.phase)! || x.entry - y.entry || a - b;
}

// Walk back from any operation still waiting, through the ones it waits on, until one repeats.
function describeCycle(operations: readonly EditOperation[], after: readonly Set<number>[], waiting: readonly number[]): string {
  const before = operations.map(() => [] as number[]);
  after.forEach((targets, i) => { for (const j of targets) before[j].push(i); });
  let at = waiting.findIndex((count) => count > 0);
  const path: number[] = [];
  while (!path.includes(at)) {
    path.push(at);
    at = before[at].find((i) => waiting[i] > 0)!;
  }
  const cycle = [...path.slice(path.indexOf(at)), at].map((i) => operations[i].label);
  const labels = cycle.filter((label, k) => k === 0 || label !== cycle[k - 1]);
  return "these words depend on each other in an order one call can't satisfy: " + labels.join(" ← ") + ". Split them across two calls.";
}

// ---- inheritance: which main components a layer's values come from ----

/** The instances a layer sits in, outermost first, by id (its own when it is one): `I<a>;<b>;<c>` sits in `a` and `I<a>;<b>`. */
function instanceChainOf(layerId: string, isInstance: boolean): string[] {
  const chain: string[] = [];
  if (isSublayerId(layerId)) {
    const parts = layerId.slice(1).split(";");
    chain.push(parts[0]);
    for (let k = 2; k < parts.length; k++) chain.push("I" + parts.slice(0, k).join(";"));
  }
  if (isInstance) chain.push(layerId);
  return chain;
}

/** Each instance's main component, by instance id, as prepare resolved it. */
export type InstanceMains = ReadonlyMap<string, { readonly instance: InstanceNode; readonly main: ComponentNode }>;

/**
 * Resolve the main component of every instance `layers` sit in. Prepare runs it: a main component
 * has no sync read under dynamic-page. An instance or main that can't be read is left out.
 */
export async function resolveInstanceMains(layers: readonly { readonly id: string; readonly type: string }[]): Promise<InstanceMains> {
  const ids = new Set(layers.flatMap((layer) => instanceChainOf(layer.id, layer.type === "INSTANCE")));
  const mains = new Map<string, { instance: InstanceNode; main: ComponentNode }>();
  await Promise.all([...ids].map(async (id) => {
    const instance = await figma.getNodeByIdAsync(id);
    if (!instance || instance.type !== "INSTANCE") return;
    const main = await instance.getMainComponentAsync();
    if (main) mains.set(id, { instance, main });
  }));
  return mains;
}

/**
 * `mains` minus every instance re-pointed since prepare, proven by the one sync fact that mirrors a
 * main component: an instance's sublayer ids are its component's, prefixed. Only ordering reads
 * these, so a stale one is dropped rather than refused.
 */
export function provenInstanceMains(mains: InstanceMains, stillShows: (instance: InstanceNode, main: ComponentNode) => boolean): InstanceMains {
  return new Map([...mains].filter(([, { instance, main }]) => !instance.removed && stillShows(instance, main)));
}

/** The main components (and their sets) `layerId`'s values come from: every instance it sits in. */
export function definitionsInheritedBy(layerId: string, isInstance: boolean, mains: InstanceMains): Set<string> {
  const out = new Set<string>();
  for (const id of instanceChainOf(layerId, isInstance)) {
    const main = mains.get(id)?.main;
    if (main) out.add(main.id);
  }
  return out;
}

/** The components whose definition a write on `node` edits: every component it sits in, itself included. */
export function definitionsEditedAt(node: BaseNode): Set<string> {
  const out = new Set<string>();
  for (let n: BaseNode | null = node; n && n.type !== "PAGE" && n.type !== "DOCUMENT"; n = n.parent) {
    if (n.type === "COMPONENT" || n.type === "COMPONENT_SET") out.add(n.id);
  }
  return out;
}
