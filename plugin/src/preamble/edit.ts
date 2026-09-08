// edit — the mutate verb itself. Everything it drives lives elsewhere: the staged pipeline in
// edit-plan.ts (see that module's header for the stages and why their order is the contract), the
// INSTANCE half in instance.ts. This module is the ORDER those two are composed in, once, so
// `editMany` composes them the same way.
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
import { resolveTarget } from "./read.js";
import { enterMutatingVerb } from "./mutation-lock.js";
import { mintHandle, resolvePercents, beginRenderWalk } from "./bridge.js";
import {
  rejectNonDeltaWords, compileEditPlan, loadEditResources, assertEditPlanStillApplies,
  openEditPlanApply, applyEditPlanWrites, settleEditPlanSizes, settleEditPlanPositions,
} from "./edit-plan.js";
import {
  prepareInstanceEditPlan, assertOverridePlansStillApply, applyInstanceRetarget, applyInstanceOverrides, InstanceEditPlan,
} from "./instance.js";
import {
  prepareComponentEditPlan, applyComponentDefinitionEdit, applyComponentBindingEdit, ComponentEditPlan,
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
    // Prepare — serialized, read-only, apply-time-fresh: every validation and canvas read
    // (vocabulary, resolve, gates, enrichment) and every await (fonts, images) lives here; a
    // throw rejects the verb with zero writes and zero undo residue.
    async () => {
      rejectNonDeltaWords(changes, SUBJECT);
      const plan = compileEditPlan(await resolveTarget(target), changes, SUBJECT);
      // The instance resolution runs BEFORE the resource load: an override delta's compiled text
      // decides which fonts to load, exactly as render's instance prepare does.
      const instance: InstanceEditPlan | undefined = plan.instanceWords
        ? await prepareInstanceEditPlan(plan.node, plan.instanceWords, SUBJECT)
        : undefined;
      // The COMPONENT half is resolved beside it, and before the resource load for the same reason:
      // it costs no round trip, so a bad property name rejects without paying for a font fetch.
      // It gets no stage-4 re-read, deliberately: every write it makes names a property by its full
      // name, and a definition that moved during the load fails inside the sealed span, which rolls
      // the whole delta back — loud, where a stale override plan would be silent.
      const component: ComponentEditPlan | undefined = plan.componentWords
        ? await prepareComponentEditPlan(plan.node, plan.componentWords, SUBJECT)
        : undefined;
      const resources = await loadEditResources([plan, ...(instance ? instance.overrides.map((o) => o.plan) : [])], instance ? [instance.needs] : []);
      // The root's own gate reads the container this delta LEAVES BEHIND (a swap re-points the
      // instance before its layout words land), and every override plan compiled against a live
      // sublayer gets the same stage-4 pass — here, where a stale one costs zero writes.
      assertEditPlanStillApplies(plan, SUBJECT, undefined, instance ? instance.becomesRowColumn : undefined);
      if (instance) assertOverridePlansStillApply(instance, SUBJECT);
      return { plan, instance, component, resources };
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
