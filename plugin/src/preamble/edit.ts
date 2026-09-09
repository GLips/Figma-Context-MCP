// edit — the mutate verb itself. Everything it drives lives elsewhere: the staged pipeline in
// edit-plan.ts (see that module's header for the stages and why their order is the contract), the
// INSTANCE half in instance.ts, the COMPONENT half in component-edit.ts. This module is the ORDER
// those are composed in, once, so `editMany` composes them the same way.
//
// An INSTANCE delta brackets the node-local stages rather than joining them, because a swap or a
// variant change REPLACES the sublayer tree the override paths name:
//
//   retarget (swapComponent, setProperties) → 5a writes → 5b sizes → 5c positions → overrides
//
// The root words land on the instance the retarget produced (a swapped instance's fill is the new
// component's until this delta's own `fill` writes over it), and the overrides land last, on
// sublayers re-acquired after the tree moved.
//
// A COMPONENT delta brackets them too, on both sides (component-edit.ts):
//
//   definitions → 5a writes → binding → 5b sizes → 5c positions
//
// The definitions go first so a rename is part of the same undo step as everything else the delta
// says; the binding goes right after the writes, so a layer is what this delta makes it before it
// is wired to a property.

import { Target, Handle } from "./ir.js";
import { resolveTarget, createResolvedTargets } from "./read.js";
import { enterMutatingVerb } from "./mutation-lock.js";
import { assertNodeStillOnCanvas } from "./freshness.js";
import { mintHandle, resolvePercents, beginRenderWalk } from "./bridge.js";
import {
  rejectNonDeltaWords, compileEditPlan, loadEditResources, assertEditPlanLands, gateEditResources,
  openEditPlanApply, applyEditPlanWrites, settleEditPlanSizes, settleEditPlanPositions,
} from "./edit-plan.js";
import {
  resolveInstanceEditTargets, planInstanceEdit, applyInstanceRetarget, applyInstanceOverrides, InstanceEditPlan,
} from "./instance.js";
import {
  resolveComponentEditTargets, planComponentEdit, applyComponentDefinitionEdit, applyComponentBindingEdit, ComponentEditPlan,
} from "./component-edit.js";
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
      rejectNonDeltaWords(changes, SUBJECT);
      const node = await resolveTarget(target);
      const hint = compileEditPlan(node, changes, SUBJECT);
      const targets = createResolvedTargets();
      const current = hint.instanceWords ? await resolveInstanceEditTargets(node, hint.instanceWords, targets) : null;
      if (hint.componentWords) await resolveComponentEditTargets(node, hint.componentWords, targets);
      const instance = hint.instanceWords ? planInstanceEdit(node, hint.instanceWords, current, { targets }, SUBJECT) : undefined;
      const loaded = await loadEditResources([hint, ...(instance ? instance.overrides.map((o) => o.plan) : [])], instance ? [instance.needs] : []);
      return { node, targets, current, loaded };
    },
    // Gate — every decision that reads the document, made against it as it stands at the seal:
    // the compile, the instance and component halves, and the root's own layout gate, which reads
    // the container this delta LEAVES BEHIND (a swap re-points the instance before its layout
    // words land — `becomesRowColumn`).
    ({ node, targets, current, loaded }) => {
      assertNodeStillOnCanvas(node, SUBJECT);
      const plan = compileEditPlan(node, changes, SUBJECT);
      const planning = { targets, fonts: loaded.fonts };
      const instance: InstanceEditPlan | undefined = plan.instanceWords ? planInstanceEdit(node, plan.instanceWords, current, planning, SUBJECT) : undefined;
      const component: ComponentEditPlan | undefined = plan.componentWords ? planComponentEdit(node, plan.componentWords, targets, SUBJECT) : undefined;
      assertEditPlanLands(plan, loaded.fonts, SUBJECT, undefined, instance ? instance.becomesRowColumn : undefined);
      return { plan, instance, component, resources: gateEditResources(loaded, instance ? [instance.needs] : []) };
    },
    // Apply — the sealed span: all writes, no awaits.
    ({ plan, instance, component, resources }) => {
      const fail = openEditPlanApply("edit", plan);
      if (instance) applyInstanceRetarget(fail, plan.node, instance);
      if (component && component.definitions) applyComponentDefinitionEdit(fail, plan.node, component.definitions);
      applyEditPlanWrites(fail, plan, resources);
      if (component && component.binding) applyComponentBindingEdit(fail, plan.node, component.binding);
      settleEditPlanSizes(fail, plan);
      settleEditPlanPositions(fail, plan);
      if (instance) {
        // Slot content among the overrides is BUILT, so it needs a walk; its percents settle once
        // the whole delta has landed, as a render's do after its tree.
        const walk = beginRenderWalk(resources);
        applyInstanceOverrides(plan.node, instance, walk, "edit");
        resolvePercents(walk);
      }
      return mintHandle(plan.node);
    },
  );
}
