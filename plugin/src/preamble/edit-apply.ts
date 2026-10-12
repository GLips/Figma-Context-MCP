/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// edit-apply — the ONE order a gated edit lands in, for every caller that lands one: flcm.edit (one
// entry), flcm.editMany (the batch, ancestors first) and a live node an authored tree places
// (live-tree.ts, one entry at a time as the walk reaches it). Stage-major: every entry finishes a
// stage before any entry starts the next, so nothing measures a canvas another entry is still
// writing to — an entry centring a hugging panel must not read the width another entry is about
// to grow it to.
//
//   binding release → retarget → definitions → writes → bound defaults → binding
//     → sizes → positions → overrides
//
// The release comes first, so no later stage writes into a property a field is leaving. The
// retarget comes before the writes because a swap or variant change replaces the sublayer tree
// (the root words land on what it produces, the overrides last on sublayers re-acquired after it).
// Definitions precede the writes so a rename is in the same undo step; the binding follows them so
// a layer is what this delta makes it before it is wired to a property.

import type { RenderCtx } from "./bridge.js";
import { applyEditPlanWrites, settleEditPlanSizes, settleEditPlanPositions, type EditPlan, type EditPlanFailure } from "./edit-plan.js";
import { applyInstanceRetarget, applyInstanceOverrides, type InstanceEditPlan } from "./instance.js";
import {
  applyBindingRelease, applyComponentDefinitionEdit, applyBoundDefaults, applyComponentBindingEdit, type ComponentEditPlan, type AddedDefinition,
} from "./component-edit.js";

/** One gated edit, as the driver lands it. */
export interface EditApplyEntry {
  node: SceneNode;
  /** Opened before the batch's first write: it snapshots the identity a failure names. */
  fail: EditPlanFailure;
  /** Absent for a live node a tree only moves (or only re-paths). */
  plan?: EditPlan;
  instance?: InstanceEditPlan;
  component?: ComponentEditPlan;
  /** How the overrides' slot content names this entry in a refusal. */
  subject: string;
  /** A placing caller's own node-local writes, landed just before the delta's (live-tree's path data). */
  beforeWrites?(): void;
  /** A placing caller's own stages between the binding and the size settle (live-tree's key, binding bag, children). */
  afterBinding?(): void;
}

/** Land `entries` stage by stage, in the order given. `walk` builds the overrides' slot content. */
export function applyEditStages(entries: readonly EditApplyEntry[], walk: RenderCtx): void {
  for (const e of entries) if (e.component?.binding) applyBindingRelease(e.fail, e.node, e.component.binding);
  for (const e of entries) if (e.instance) applyInstanceRetarget(e.fail, e.node, e.instance);
  // A binding in one entry may name a property another entry adds: the minted names are the
  // definitions stage's output and the binding stage's input.
  const minted = new Map<AddedDefinition, string>();
  for (const e of entries) {
    if (e.component?.definitions) for (const [add, name] of applyComponentDefinitionEdit(e.fail, e.node, e.component.definitions)) minted.set(add, name);
  }
  for (const e of entries) e.beforeWrites?.();
  for (const e of entries) if (e.plan) applyEditPlanWrites(e.fail, e.plan, walk);
  for (const e of entries) if (e.component?.defaults) applyBoundDefaults(e.fail, e.component.defaults);
  for (const e of entries) if (e.component?.binding) applyComponentBindingEdit(e.fail, e.node, e.component.binding, minted);
  for (const e of entries) e.afterBinding?.();
  for (const e of entries) if (e.plan) settleEditPlanSizes(e.fail, e.plan);
  for (const e of entries) if (e.plan) settleEditPlanPositions(e.fail, e.plan, walk.span);
  for (const e of entries) if (e.instance) applyInstanceOverrides(e.node, e.instance, walk, e.subject);
}
