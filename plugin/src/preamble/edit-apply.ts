/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// edit-apply — how a gated edit lands, for every caller that lands one: flcm.edit (one entry),
// flcm.editMany (the batch), flcm.clone's copy and the live nodes an authored tree places
// (live-tree.ts). Each entry's write is split into operations, one per phase, and every override
// path's into its own; the gate orders them across the whole call (operation-schedule.ts) and
// apply runs them in that order. A placed live node lands its attach-time phases as it is placed.
//
// On one layer the phases keep one order:
//
//   binding release → retarget → definitions → path data → appearance → text → container
//     → placement → own size → cover → constraints → bound defaults → binding → children
//     → percent sizes → aspect ratios → clamps → percent positions
//
// The release comes first, so no later write lands in a property a field is leaving. The retarget
// comes before the writes because a swap or variant change replaces the sublayer tree (the root
// words land on what it produces, the overrides on sublayers re-acquired after it). Definitions precede the bindings that name what they mint.
//
// Across layers a write lands before every operation whose words it can move: a parent's resize
// before its pinned child's left, a percent before the width of a child it stretches, a main
// component's edit before an instance layer restating the old value. Each operation is a write
// point (write-point.ts): it observes what the earlier ones left and writes only what is still owed.

import { describeNodeIdentity } from "./identity.js";
import type { RenderCtx } from "./bridge.js";
import {
  applyEditPlanPhase, trackEditPlanSizing, openEditPlanApply, EDIT_PLAN_PHASES, type EditPlanFailure, type EditPlanPhase,
} from "./edit-plan.js";
import type { AuthorizedEditPlan } from "./instance-write-authorization.js";
import { applyInstanceRetarget, overrideOperationsOf, beginOverrideApply, type InstanceEditPlan, type OverrideOperation } from "./instance.js";
import {
  applyBindingRelease, applyComponentDefinitionEdit, applyBoundDefaults, applyComponentBindingEdit, type ComponentEditPlan, type AddedDefinition,
} from "./component-edit.js";
import { geometryWritesAt, writePointGeometryReads, wholeBoxWrites, type GeometryEffect, type GeometryProjection } from "./geometry-dependency.js";
import {
  definitionsEditedAt, definitionsInheritedBy, scheduleEditOperations, type EditOperation, type EditOperationPhase, type InstanceMains, type OperationRef,
} from "./operation-schedule.js";
import type { Obligation, PatchFieldKey } from "./obligation.js";
import type { WriteProps } from "./ir.js";
import { obligationsOnNode } from "./write-point.js";
import { beginMutatingApply } from "./verb-error.js";
import { liveSublayerId } from "@framelink/core";

/** One gated edit, as the gate schedules it and apply lands it. */
export interface EditApplyEntry {
  node: SceneNode;
  /** Absent for a live node a tree only moves (or only re-paths). */
  plan?: AuthorizedEditPlan;
  instance?: InstanceEditPlan;
  component?: ComponentEditPlan;
  /** How the span names the entry ("editMany (entry 2)"), and so how its failures read. */
  subject: string;
  /** How a cycle refusal tags its words: `[2]` in a batch, a tree's source path. */
  tag: string;
  /** Opened by the caller when it already began the entry's apply (a placed live node); otherwise apply opens it. */
  fail?: EditPlanFailure;
  /** A placing caller's own path data, landed just before the delta's writes (live-tree). */
  vectorPath?(): void;
  /** A placing caller's own writes between the binding and the size settle (live-tree's key, binding bag, children). */
  afterBinding?(): void;
}

/**
 * What the scheduler reads of one entry. An edit's comes from its authorized plan; a live tree's
 * node is scheduled at the gate, before the parent it lands under exists to authorize against, so
 * it states the same facts from its compiled plan.
 */
export interface EditEntryShape {
  readonly node: SceneNode;
  /** Its compiled words, and the fields the instance write policy leaves realize-only. */
  readonly patch?: WriteProps;
  readonly unwritten?: ReadonlySet<PatchFieldKey>;
  /** A turned layer the instance doesn't lock, whose last phase re-centres its pivot on its final box. */
  readonly turned?: boolean;
  readonly instance?: InstanceEditPlan;
  readonly component?: ComponentEditPlan;
  readonly vectorPath?: boolean;
  readonly afterBinding?: boolean;
  readonly tag: string;
  /** The words it owes, where the gate schedules them before recording them; else the ledger's. */
  readonly obligations?: readonly Obligation[];
  /** The operation that attaches it where it lands, when another entry's does (a live tree's child). */
  readonly attachedBy?: OperationRef;
}

type EntryOperation = (EditOperation & { readonly override?: undefined }) | OverrideOperation;

/** The call's operations, in the order apply runs them. */
export interface EditSchedule {
  readonly operations: readonly EntryOperation[];
}

export interface EditScheduling {
  /** Each instance's main component, as prepare resolved it: what a layer inherits from. */
  readonly mains?: InstanceMains;
}

/** The scheduler's view of an authorized entry. */
function shapeOf(entry: EditApplyEntry): EditEntryShape {
  const { node, plan, instance, component, tag } = entry;
  return {
    node, instance, component, tag, vectorPath: !!entry.vectorPath, afterBinding: !!entry.afterBinding,
    patch: plan?.source.patch,
    unwritten: new Set(plan?.realizeOnly.keys() ?? []),
    turned: !!plan && !plan.instanceWords && !plan.context.ownWritesLockedBy && !!((node as { rotation?: number }).rotation || plan.rotation),
  };
}

// Every operation of one entry, in the phase order it lands in on its layer, and its layout words
// (and its live override paths') into `projection`.
function operationsOfShape(shape: EditEntryShape, index: number, mains: InstanceMains, projection: Record<string, GeometryProjection[string]>): EntryOperation[] {
  const { node, patch, instance, component } = shape;
  if (patch?.layout) projection[node.id] = patch.layout;
  const defines = definitionsEditedAt(node);
  const inherits = definitionsInheritedBy(node.id, node.type === "INSTANCE", mains);
  if (instance) inherits.add(instance.becomes.id);
  const unwritten = shape.unwritten ?? new Set();
  const waitsFor = shape.attachedBy ? [shape.attachedBy] : undefined;
  const operations: EntryOperation[] = [];
  const add = (phase: EditOperationPhase, writes: readonly GeometryEffect[] = [], reads: readonly GeometryEffect[] = []) =>
    operations.push({ entry: index, phase, layer: node.id, writes, reads, defines, inherits, waitsFor, label: labelOf(shape, phase) });
  if (component?.binding) add("binding-release");
  if (instance) add("retarget", instance.retargets || Object.keys(instance.properties).length ? wholeBoxWrites(node) : []);
  if (component?.definitions) add("definitions");
  if (shape.vectorPath) add("vector-path", wholeBoxWrites(node));
  if (patch) for (const phase of EDIT_PLAN_PHASES) add(phase, geometryWritesAt(node, patch, phase, unwritten), phaseReads(shape, phase));
  if (component?.defaults) add("bound-defaults");
  if (component?.binding) add("binding");
  if (shape.afterBinding) add("after-binding", [{ node, aspect: "flow" }]);
  if (instance?.overrides.length) {
    for (const o of instance.overrides) if (o.context.basis === "live" && o.plan.patch.layout) projection[liveSublayerId(node.id, o.path)] = o.plan.patch.layout;
    operations.push(...overrideOperationsOf(node, instance.overrides, {
      entry: index, tag: shape.tag, becomes: instance.becomes, mains, attachedBy: shape.attachedBy, obligations: shape.obligations,
    }));
  }
  return operations;
}

/**
 * Order every operation of `entries` across the call. Run at the gate, after the call's
 * obligations are recorded (they are what each operation reads): a cycle is refused with zero writes.
 */
export function scheduleEditEntries(entries: readonly EditApplyEntry[], subject: string, scheduling: EditScheduling = {}): EditSchedule {
  const mains = scheduling.mains ?? new Map();
  const projection: Record<string, GeometryProjection[string]> = {};
  const operations = entries.flatMap((entry, index) => operationsOfShape(shapeOf(entry), index, mains, projection));
  return { operations: scheduleEditOperations(operations, subject, projection) };
}

// What a phase's written words read, and for a turned layer's last phase the box its pivot re-centres on.
function phaseReads(shape: EditEntryShape, phase: EditPlanPhase): GeometryEffect[] {
  const reads = writePointGeometryReads(shape.node, phase, shape.obligations);
  // An instance's pivot waits for the span's settle instead (edit-plan.ts appearance).
  if (phase === "percent-position" && shape.turned) reads.push({ node: shape.node, aspect: "size-h" }, { node: shape.node, aspect: "size-v" });
  return reads;
}

// `[0] "Card" width`: the entry, the layer, and the words this phase writes.
function labelOf(shape: EditEntryShape, phase: EditOperationPhase): string {
  const words = [...new Set(obligationsOnNode(shape.node, shape.obligations).filter((o) => o.writePoint === phase).map((o) => o.source.path))];
  return shape.tag + " " + describeNodeIdentity(shape.node) + " " + (words.length ? words.join(", ") : "(" + phase + ")");
}

/** Land `schedule`'s operations, in order. `walk` builds the overrides' slot content. */
export function runEditOperations(entries: readonly EditApplyEntry[], schedule: EditSchedule, walk: RenderCtx): void {
  const run = openEditRun(walk);
  // Every entry's failure builder before the call's first write: it snapshots the identity the
  // error will name, and an earlier rename must not be what a later phase's failure reports.
  for (const entry of entries) run.open(entry);
  for (const operation of schedule.operations) {
    run.land(entries[operation.entry], operation);
    // Slot content an operation just filled may hold live nodes, whose own operations follow.
    landPlacedLiveOperations(walk);
  }
}

/** One call's apply of its operations: the state every operation of every entry shares. */
interface EditRun {
  /** Open the entry's failure builder and sizing snapshot, before its first write. */
  open(entry: EditApplyEntry): void;
  land(entry: EditApplyEntry, operation: EntryOperation): void;
}

function openEditRun(walk: RenderCtx): EditRun {
  const fails = new Map<EditApplyEntry, EditPlanFailure>();
  // A binding in one entry may name a property another entry adds: the minted names are the
  // definitions phase's output and the binding phase's input.
  const minted = new Map<AddedDefinition, string>();
  const overrides = new Map<EditApplyEntry, (operation: OverrideOperation) => void>();
  const open = (entry: EditApplyEntry): EditPlanFailure => {
    let fail = fails.get(entry);
    if (fail) return fail;
    fail = entry.fail ?? (entry.plan ? openEditPlanApply(entry.subject, entry.plan, walk.span) : beginMutatingApply(entry.subject, entry.node));
    fails.set(entry, fail);
    if (entry.plan) trackEditPlanSizing(entry.plan);
    return fail;
  };
  return {
    open,
    land(entry, operation) {
      const fail = open(entry);
      const { node, plan, instance, component } = entry;
      if (operation.override) {
        let land = overrides.get(entry);
        if (!land) overrides.set(entry, (land = beginOverrideApply(node, walk, entry.subject)));
        land(operation);
        return;
      }
      switch (operation.phase) {
        case "binding-release": applyBindingRelease(fail, node, component!.binding!); break;
        case "retarget": applyInstanceRetarget(fail, node, instance!); break;
        case "definitions":
          for (const [add, name] of applyComponentDefinitionEdit(fail, node, component!.definitions!)) minted.set(add, name);
          break;
        case "vector-path": landCallerWrites(fail, entry.vectorPath!); break;
        case "bound-defaults": applyBoundDefaults(fail, component!.defaults!); break;
        case "binding": applyComponentBindingEdit(fail, node, component!.binding!, minted); break;
        case "after-binding": landCallerWrites(fail, entry.afterBinding!); break;
        case "slot-content": break;
        default: applyEditPlanPhase(fail, plan!, operation.phase, walk);
      }
    },
  };
}

function landCallerWrites(fail: EditPlanFailure, writes: () => void): void {
  try { writes(); } catch (cause) { throw fail(cause); }
}

// ---- a live tree's nodes: placed by the walk, landed by the call's schedule ----

// What a live node lands where it is attached, before anything else is attached under it: its
// instance and component halves, path data, appearance, text and container. Its children attach
// under that container, and every write that moves geometry waits for the schedule.
const LANDS_AT_ATTACH: ReadonlySet<EditOperationPhase> = new Set(["binding-release", "retarget", "definitions", "vector-path", "appearance", "text", "container"]);

/**
 * A live tree's operations, scheduled at the gate across every live node it names. The walk places
 * each node (live-tree.ts), which lands its attach-time operations and enters it here; the rest run
 * in schedule order once their node is placed (landPlacedLiveOperations). A node attached by
 * another's operation (its parent's children, a slot's content) waits for that operation, so a
 * parent's resize lands before the children it moves are placed and sized, and a sibling's growth
 * of a hugging parent before the pinned child it moves.
 */
export interface LiveTreeLanding {
  /** By entry index, as the walk places each node. */
  readonly placed: (EditApplyEntry | undefined)[];
  readonly atAttach: readonly (readonly EntryOperation[])[];
  readonly schedule: EditSchedule;
  readonly landed: boolean[];
  run?: EditRun;
  landing: boolean;
}

/**
 * Schedule `shapes` (a live tree's nodes, by entry index) at the gate, `mains` being what each
 * instance they sit in shows. A cycle is refused with zero writes.
 */
export function scheduleLiveTree(shapes: readonly EditEntryShape[], subject: string, mains: InstanceMains): LiveTreeLanding {
  const projection: Record<string, GeometryProjection[string]> = {};
  const all = shapes.map((shape, index) => operationsOfShape(shape, index, mains, projection));
  const later = all.flatMap((operations) => operations.filter((op) => op.override || !LANDS_AT_ATTACH.has(op.phase)));
  const schedule = { operations: scheduleEditOperations(later, subject, projection) };
  return {
    placed: shapes.map(() => undefined),
    atAttach: all.map((operations) => operations.filter((op) => !op.override && LANDS_AT_ATTACH.has(op.phase))),
    schedule, landed: schedule.operations.map(() => false), landing: false,
  };
}

/** Enter a live node the walk just attached, and land its attach-time operations. */
export function landAttachedLiveNode(landing: LiveTreeLanding, index: number, entry: EditApplyEntry, walk: RenderCtx): void {
  const run = (landing.run ??= openEditRun(walk));
  run.open(entry);
  landing.placed[index] = entry;
  for (const operation of landing.atAttach[index]) run.land(entry, operation);
}

/**
 * Land every scheduled operation whose node is placed, in schedule order. An operation that places
 * more nodes (a parent's children) is followed by theirs. Called once a walk has attached what it
 * builds: after a tree lands, and after an edit's operation fills a slot.
 */
export function landPlacedLiveOperations(walk: RenderCtx): void {
  const landing = walk.liveLanding;
  // Re-entered from inside one of its own operations, the outer pass reaches whatever this one would.
  if (!landing || landing.landing) return;
  landing.landing = true;
  try {
    const run = (landing.run ??= openEditRun(walk));
    landing.schedule.operations.forEach((operation, i) => {
      const entry = landing.placed[operation.entry];
      if (landing.landed[i] || !entry) return;
      landing.landed[i] = true;
      run.land(entry, operation);
    });
  } finally {
    landing.landing = false;
  }
}
