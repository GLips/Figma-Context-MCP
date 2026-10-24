/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { compileDeltaTrees } from "./compile-tree.js";
// edit — the mutate verb itself: prepare and gate one delta, then land it through the one apply
// driver (edit-apply.ts) that editMany and a placed live node share, in the order its gate
// schedules. The phases live in edit-plan.ts, the INSTANCE half in instance.ts, the COMPONENT half
// in component-edit.ts.

import { Target, Handle } from "./ir.js";
import { resolveTarget, createResolvedTargets } from "./target.js";
import { enterMutatingVerb } from "./mutation-lock.js";
import { assertNodeStillOnCanvas } from "./freshness.js";
import { mintHandle, beginRenderWalk } from "./bridge.js";
import { rejectNonDeltaWords, compileEditPlan, authorizeEditPlan } from "./edit-plan.js";
import { recordObligations } from "./obligation.js";
import {
  deriveDriftObligations, deriveEditObligations, liveObligationSite, obligationsOnTarget, realizeOnlyChecksOf,
} from "./obligation-derivation.js";
import { loadEditResources, gateEditResources } from "./verb-resources.js";
import {
  resolveInstanceEditTargets, planInstanceEdit, overrideRealizeOnlyChecks, instanceGeometryWrites, withoutRetargetHeldChecks, InstanceEditPlan,
} from "./instance.js";
import { planComponentEdit, projectedBinderValue, ComponentEditPlan } from "./component-edit.js";
import { scheduleEditEntries, runEditOperations, type EditApplyEntry } from "./edit-apply.js";
import { captureReadDependencies, gateCallObligations, NO_READ_DEPENDENCIES } from "./call-obligations.js";
import type { EditDelta } from "./schema.js";

const SUBJECT = "flcm.edit";

/**
 * flcm.edit(target, changes) — nudge an existing node. Resolves the target (key | id |
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
    // node); nothing it concludes lands, except what its words read before the loads, which the
    // gate compares against. A throw rejects the verb with zero writes.
    async () => {
      changes = compileDeltaTrees(changes, SUBJECT);
      rejectNonDeltaWords(changes, SUBJECT);
      const node = await resolveTarget(target);
      const hint = compileEditPlan(node, changes, SUBJECT);
      const targets = createResolvedTargets();
      const current = hint.instanceWords ? await resolveInstanceEditTargets(node, hint.instanceWords, targets) : null;
      const instance = hint.instanceWords ? planInstanceEdit(node, hint.instanceWords, current, { targets }, SUBJECT) : undefined;
      let dependencies = NO_READ_DEPENDENCIES;
      const loaded = await loadEditResources([hint, ...(instance ? instance.overrides.map((o) => o.plan) : [])], instance ? [instance.needs] : [], (tokens) => {
        dependencies = captureReadDependencies(deriveDriftObligations(hint, instance, tokens, liveObligationSite(node), SUBJECT));
      });
      // A swap binder's component is what its instance_swap property's default is judged against.
      const refs = hint.componentWords?.componentPropertyReferences as Record<string, unknown> | undefined;
      const main = node.type === "INSTANCE" && refs?.componentId != null ? await (node as InstanceNode).getMainComponentAsync() : null;
      return { node, targets, current, loaded, dependencies, main };
    },
    // Gate — every decision that reads the document, made against it as it stands at the seal:
    // the compile, the instance and component halves, and the root's own layout gate, which reads
    // the container this delta LEAVES BEHIND (a swap re-points the instance before its layout
    // words land — `becomesContainer`). Every word is owed; which of them are written is decided
    // at each write point in apply.
    ({ node, targets, current, loaded, dependencies, main }) => {
      assertNodeStillOnCanvas(node, SUBJECT);
      const plan = compileEditPlan(node, changes, SUBJECT);
      const planning = { targets, gate: loaded };
      const instance: InstanceEditPlan | undefined = plan.instanceWords ? planInstanceEdit(node, plan.instanceWords, current, planning, SUBJECT) : undefined;
      const component: ComponentEditPlan | undefined = plan.componentWords
        ? planComponentEdit(node, plan.componentWords, SUBJECT, (field) => projectedBinderValue(field, node, plan, instance, main, SUBJECT))
        : undefined;
      const authorized = authorizeEditPlan(plan, loaded, SUBJECT, { becomes: instance?.becomesContainer });
      const site = liveObligationSite(node);
      const owed = obligationsOnTarget(deriveEditObligations(plan, instance, loaded, site), { node }, SUBJECT);
      recordObligations(owed);
      const entry: EditApplyEntry = { node: authorized.node, plan: authorized, instance, component, subject: "edit", tag: SUBJECT };
      gateCallObligations({
        obligations: owed,
        dependencies,
        checks: [
          ...withoutRetargetHeldChecks(realizeOnlyChecksOf(plan, authorized.realizeOnly, loaded, site, SUBJECT, authorized.context), instance),
          ...(instance ? overrideRealizeOnlyChecks(instance.overrides, loaded, SUBJECT) : []),
        ],
        writes: instance ? instanceGeometryWrites(node, plan.patch, instance) : [],
      }, SUBJECT);
      const schedule = scheduleEditEntries([entry], SUBJECT);
      return { entry, schedule, resources: gateEditResources(loaded, instance ? [instance.needs] : [], SUBJECT) };
    },
    // Apply — the sealed span: all writes, no awaits.
    ({ entry, schedule, resources }, span) => {
      // The walk builds any slot content among the overrides; its percents settle with the span.
      runEditOperations([entry], schedule, beginRenderWalk({ ...resources, span }));
      return () => mintHandle(entry.node);
    },
  );
}
