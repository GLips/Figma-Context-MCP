/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { compileDeltaTrees } from "./compile-tree.js";
// edit — the mutate verb itself: prepare and gate one delta, then land it through the one apply
// driver (edit-apply.ts) that editMany and a placed live node share. The stages live in
// edit-plan.ts, the INSTANCE half in instance.ts, the COMPONENT half in component-edit.ts.

import { Target, Handle } from "./ir.js";
import { resolveTarget, createResolvedTargets } from "./read.js";
import { enterMutatingVerb } from "./mutation-lock.js";
import { assertNodeStillOnCanvas } from "./freshness.js";
import { mintHandle, settleApplySpan, beginRenderWalk } from "./bridge.js";
import {
  rejectNonDeltaWords, compileEditPlan, restatedEditPlan, loadEditResources, assertEditPlanLands, gateEditResources, openEditPlanApply,
} from "./edit-plan.js";
import { resolveInstanceEditTargets, planInstanceEdit, InstanceEditPlan } from "./instance.js";
import { planComponentEdit, projectedBinderValue, ComponentEditPlan } from "./component-edit.js";
import { applyEditStages } from "./edit-apply.js";
import { createStandingState } from "./standing-state.js";
import type { EditDelta } from "./schema.js";

const SUBJECT = "flcm.edit";

/**
 * flcm.edit(target, changes) — nudge an existing node. Resolves the target (key | id | flcm.id() |
 * handle), validates the whole delta before the first write, applies it through the bridge's
 * appliers under the mutation lock (one undo step; a Figma refusal rolls back commit-then-undo),
 * and returns the node's updated Handle with fresh geometry.
 */
// A single expression on purpose: the queue slot is reserved before edit() can possibly yield,
// which is the lock's invocation-order guarantee (see enterMutatingVerb) — don't add work above it.
export function edit(target: Target, changes: EditDelta): Promise<Handle> {
  return enterMutatingVerb(
    "edit",
    // Prepare — the target, every target the delta names, and the resources. The compile runs here
    // once as the HINT of what to load (an override's or a text delta's fonts follow the live
    // node); nothing it concludes lands. A throw rejects the verb with zero writes.
    async () => {
      changes = compileDeltaTrees(changes, SUBJECT);
      rejectNonDeltaWords(changes, SUBJECT);
      const node = await resolveTarget(target);
      const standing = createStandingState();
      await standing.load(node);
      const authored = changes;
      changes = standing.changesInCall([{ node, words: changes }])[0] as EditDelta;
      const restated = Object.keys(authored).length > 0 && Object.keys(changes).length === 0;
      const hint = restated ? restatedEditPlan(node) : compileEditPlan(node, changes, SUBJECT);
      const targets = createResolvedTargets();
      const current = hint.instanceWords ? await resolveInstanceEditTargets(node, hint.instanceWords, targets) : null;
      const instance = hint.instanceWords ? planInstanceEdit(node, hint.instanceWords, current, { targets }, SUBJECT) : undefined;
      const loaded = await loadEditResources([hint, ...(instance ? instance.overrides.map((o) => o.plan) : [])], instance ? [instance.needs] : []);
      // A swap binder's component is what its instance_swap property's default is judged against.
      const refs = hint.componentWords?.componentPropertyReferences as Record<string, unknown> | undefined;
      const main = node.type === "INSTANCE" && refs?.componentId != null ? await (node as InstanceNode).getMainComponentAsync() : null;
      return { node, targets, current, loaded, restated, main };
    },
    // Gate — every decision that reads the document, made against it as it stands at the seal:
    // the compile, the instance and component halves, and the root's own layout gate, which reads
    // the container this delta LEAVES BEHIND (a swap re-points the instance before its layout
    // words land — `becomesLayoutMode`).
    ({ node, targets, current, loaded, restated, main }) => {
      assertNodeStillOnCanvas(node, SUBJECT);
      const plan = restated ? restatedEditPlan(node) : compileEditPlan(node, changes, SUBJECT);
      const planning = { targets, fonts: loaded.fonts };
      const instance: InstanceEditPlan | undefined = plan.instanceWords ? planInstanceEdit(node, plan.instanceWords, current, planning, SUBJECT) : undefined;
      const component: ComponentEditPlan | undefined = plan.componentWords
        ? planComponentEdit(node, plan.componentWords, SUBJECT, (field) => projectedBinderValue(field, plan, instance, main, SUBJECT))
        : undefined;
      assertEditPlanLands(plan, loaded.fonts, SUBJECT, undefined, instance ? { mode: instance.becomesLayoutMode, wrap: instance.becomesLayoutWrap } : undefined);
      return { plan, instance, component, resources: gateEditResources(loaded, instance ? [instance.needs] : []) };
    },
    // Apply — the sealed span: all writes, no awaits.
    ({ plan, instance, component, resources }, span) => {
      const fail = openEditPlanApply("edit", plan, span);
      // The walk builds any slot content among the overrides; its percents settle with the span.
      applyEditStages([{ node: plan.node, fail, plan, instance, component, subject: "edit" }], beginRenderWalk({ ...resources, span }));
      // Before the handle reads the node's geometry.
      settleApplySpan(span);
      return mintHandle(plan.node);
    },
  );
}
