/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { compileDeltaTrees } from "./compile-tree.js";
import { sublayerPrefix } from "@framelink/core";
// editMany — the atomic batch form of `edit`. It exists for ONE thing a caller loop cannot build:
// set-level atomicity. Validation lives inside a verb, so `for (const e of entries) await edit(…)`
// discovers entry 4's invalid delta only after entries 1–3 have already mutated the canvas — each
// call atomic, the set not. This validates every entry before applying any, and rejects naming
// EVERY failing entry, so the agent fixes the whole batch in one pass. One undo step is the
// secondary purchase: the user steps back over the nudge they asked for, not over nine of them.
//
// It is orchestration over edit-plan.ts's write phases. Nothing here compiles or applies a delta
// itself: a second application path is exactly what invariant 1 forbids — it lands through the same
// driver as edit (edit-apply.ts), which orders every phase of every entry by what it depends on, so
// a parent's resize lands before the left of a child pinned to its far edge whatever the array
// order. Every entry owes every word it states, and the call rolls back if any didn't land. Two
// things ARE this module's own, and each is a consequence of the set being the unit rather than the entry:
//
//   • the LEDGER — a failure is recorded against its entry and the batch keeps going, so one
//     rejection names every offender ACROSS stages, not just the ones that failed together
//   • the PROJECTION — an entry whose parent this same batch is editing is judged against the
//     parent the batch will produce, not the one on the canvas (see layoutDeltasByNodeId)
//
// It takes the mutation lock ONCE, via a single enterMutatingVerb expression, and drives the
// commit-free internal appliers — never the public `edit`, which would shatter the batch into one
// undo boundary per entry (invariant 4).

import { Handle } from "./ir.js";
import { resolveTarget, createResolvedTargets, ResolvedTargets } from "./target.js";
import { enterMutatingVerb } from "./mutation-lock.js";
import { assertNodeStillOnCanvas } from "./freshness.js";
import { mintHandle, beginRenderWalk, BatchLayoutDeltas } from "./bridge.js";
import { liveSublayerId } from "@framelink/core";
import { showValue } from "./validate.js";
import { EditPlan, rejectNonDeltaWords, compileEditPlan, authorizeEditPlan } from "./edit-plan.js";
import { obligationsInCall, recordObligations } from "./obligation.js";
import {
  deriveConcurrentEditObligations, deriveEditObligations, liveObligationSite, obligationsOnTarget, realizeOnlyChecksOf,
} from "./obligation-derivation.js";
import { loadEditResources, gateEditResources } from "./verb-resources.js";
import {
  resolveInstanceEditTargets, planInstanceEdit, overrideRealizeOnlyChecks, instanceGeometryWrites, withoutRetargetHeldChecks, instanceStillShows, InstanceEditPlan, InstancePlanning,
} from "./instance.js";
import { resolveInstanceMains, provenInstanceMains, definitionsEditedAt } from "./operation-schedule.js";
import { assertNoContradictoryWords, captureReadDependencies, gateCallObligations, NO_READ_DEPENDENCIES } from "./call-obligations.js";
import { FlcmError, describeFailure, describeNodeIdentity, errorNodeOf, failureKindOf, locateFailure, messageWithinCall, type FlcmErrorNode } from "./flcm-error.js";
import type { FlcmErrorKind } from "../protocol.js";
import { geometryWritesOf } from "./geometry-dependency.js";
import type { AuthorizedEditPlan } from "./instance-write-authorization.js";
import { scheduleEditEntries, runEditOperations, type EditApplyEntry } from "./edit-apply.js";
import {
  planAddedDefinitions, planComponentDefinitionEdit, prepareComponentBindingEdit, settleExistingPropertyDefaults, existingPropertyBindings, editedBinderValue, projectedBinderValue,
  ComponentEditPlan, ComponentBindingEditPlan, AddedDefinition, PropertyBinder, ExistingPropertyBinding,
} from "./component-edit.js";
import { describeBinder } from "./component-properties.js";
import { definitionOwnerOf, editableComponentOwnerOf } from "./identity.js";
import type { EditDelta, EditEntry } from "./schema.js";

const SUBJECT = "flcm.editMany";

/** An entry's spec path: every check of that entry is located under it, and its ledger line says it once. */
function entryCall(index: number): string {
  return SUBJECT + "[" + index + "]";
}

/**
 * One entry as the pipeline works with it: the live node it addresses, and the delta to apply there.
 *
 * The split is the ONLY structural thing this verb knows about an entry. Everything after it judges
 * an ordinary edit delta through edit's own gate, so the two verbs cannot grow apart — there is no
 * per-entry allow-list here to fall out of step with the edit vocabulary.
 */
interface BatchEntry { id: string; changes: EditDelta }

/**
 * The batch's per-entry failure record — ONE rejection for the whole prepare, naming every entry
 * that failed at ANY stage.
 *
 * Rejecting at the first failing stage would be a worse contract for a blind agent than it looks:
 * the batch is all-or-nothing, so a rejection means nothing moved — and an agent told about the
 * typo in entry 0, then about the stale key in entry 5, then about entry 7's illegal word, pays a
 * full round trip per fix. The whole point of the batch is one round trip. Nothing downstream is
 * wasted on a failed entry either: every stage skips the entries already marked.
 *
 * Only the FIRST failure per entry is kept — later stages ask questions that presuppose the earlier
 * ones, so a second message from the same entry is a consequence, not a new fault.
 */
interface BatchLedger {
  /** The layer an entry resolved to, so its failures name it. */
  resolved(index: number, node: SceneNode): void;
  record(index: number, err: unknown): void;
  failed(index: number): boolean;
  rejectIfAny(): void;
}

// One entry's failure twice over: `shared` is what entries that failed the same way have in common
// (grouped on it), `own` names the entry's layer too, for an entry that failed alone.
interface EntryFailure { shared: string; own: string }

function createBatchLedger(total: number): BatchLedger {
  const failures: (EntryFailure | undefined)[] = [];
  const layers: (FlcmErrorNode | undefined)[] = [];
  const kinds = new Set<FlcmErrorKind>();
  let count = 0;
  let concurrentEdits = 0;
  return {
    resolved(index, node) {
      layers[index] = errorNodeOf(node);
    },
    record(index, err) {
      if (failures[index] !== undefined) return;
      const kind = failureKindOf(err);
      // The line already names its entry, so a path under it is said from inside it. The batch's
      // header carries the bug advice only when every entry is a bug; otherwise the line says so.
      const describe = (cause: unknown) => (cause instanceof FlcmError ? messageWithinCall(cause, entryCall(index)) : describeFailure(cause)) +
        (kind === "internal" ? " (a bug in flcm, not in your script)" : "");
      const shared = describe(err);
      failures[index] = { shared, own: layers[index] === undefined ? shared : describe(locateFailure(err, { node: layers[index] })) };
      count++;
      kinds.add(kind);
      if (kind === "concurrent-edit") concurrentEdits++;
    },
    failed(index) {
      return failures[index] !== undefined;
    },
    rejectIfAny() {
      if (!count) return;
      const remedy = kinds.size === 1 && kinds.has("internal") ? ""
        : concurrentEdits === count ? "Read those layers again and re-run it."
        : concurrentEdits ? "Fix every entry below, read again the layers edited in Figma meanwhile, and re-run it."
        : "Fix every entry below and re-run it.";
      throw new FlcmError(
        batchKindOf(kinds),
        count + " of " + total + " entries were rejected, and a batch applies all of its entries or none." +
          (remedy ? " " + remedy : "") + "\n" + collapseFailures(failures, total).join("\n"),
      );
    },
  };
}

// The batch's kind is its most actionable entry's: an entry the agent must fix outranks a Figma
// limit, a concurrent edit (re-read and re-run) ranks below both, and a bug ranks last — the whole
// batch reads as flcm's bug only when every entry is one.
const BATCH_KIND_RANK: readonly FlcmErrorKind[] = ["run-ended", "authoring", "figma", "concurrent-edit", "internal"];
function batchKindOf(kinds: ReadonlySet<FlcmErrorKind>): FlcmErrorKind {
  return BATCH_KIND_RANK.find((kind) => kinds.has(kind))!;
}

/**
 * The failure lines, one per DISTINCT message: entries that failed the same way report together as
 * `N entries (0, 2, 5): …` instead of repeating the sentence N times.
 *
 * A batch is usually one generated list, so its mistake is usually one mistake — a word misspelled
 * across forty entries would otherwise bury the two entries that failed for their own reasons in
 * forty identical lines. Distinct messages keep first-seen order, so the indexes still read
 * left-to-right.
 */
function collapseFailures(failures: readonly (EntryFailure | undefined)[], total: number): string[] {
  const indexesByMessage = new Map<string, number[]>();
  for (let i = 0; i < total; i++) {
    const failure = failures[i];
    if (failure === undefined) continue;
    const seen = indexesByMessage.get(failure.shared);
    if (seen) seen.push(i);
    else indexesByMessage.set(failure.shared, [i]);
  }
  const lines: string[] = [];
  indexesByMessage.forEach((at, message) => {
    lines.push(at.length === 1 ? "  [" + at[0] + "] " + failures[at[0]]!.own : "  " + at.length + " entries (" + at.join(", ") + "): " + message);
  });
  return lines;
}

/**
 * Run one stage over every entry the ledger hasn't already failed, recording rather than throwing.
 * THE aggregation shape — every stage below routes through it, so the batch cannot grow a second
 * way of spelling a rejection or a second place that decides when to stop.
 */
function forEachLiveEntry(ledger: BatchLedger, total: number, step: (index: number) => void): void {
  for (let i = 0; i < total; i++) {
    if (ledger.failed(i)) continue;
    try {
      step(i);
    } catch (err) {
      ledger.record(i, err);
    }
  }
}

// ---- the stages, each over the WHOLE batch ----

function assertBatchShape(entries: unknown): void {
  if (!Array.isArray(entries)) {
    throw new FlcmError(
      "authoring",
      "the first argument is an array of { id, ...changes } entries — got " + showValue(entries) +
        ". To nudge a single node, use flcm.edit(target, changes).",
    );
  }
  if (!entries.length) {
    throw new FlcmError("authoring", "the entries array is empty, so there is nothing to edit. Pass at least one { id, ...changes } entry, or skip the call.");
  }
}

/**
 * The pure, document-blind stage: it runs for every entry before a single node is resolved, so a
 * misspelled word reads as "unknown prop" no matter which node the entry names (invariant 2).
 *
 * `target` is named on its own because it is the near-miss an agent actually writes — every other
 * verb takes a positional target — and the closed-set reject would answer "unknown prop", which
 * says nothing about where the node belongs.
 */
function compileBatchEntry(entry: EditEntry, index: number): BatchEntry {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new FlcmError("authoring", "each entry is an object { id, ...changes } — got " + showValue(entry) + ".");
  }
  if ("target" in entry) {
    throw new FlcmError(
      "authoring",
      "an entry names its node with `id`, not `target` — write { id, ...changes }, the shape every verb reads and writes. " +
        "A batch edits nodes you have already located: find them first (flcm.find / flcm.findOne / a render result) and pass each one's `id`.",
    );
  }
  const { id, ...rest } = entry as { id?: unknown } & EditDelta;
  if (typeof id !== "string" || !id.trim()) {
    throw new FlcmError(
      "authoring",
      "an entry needs an `id` — the live id of the node to edit, as flcm.find, flcm.findOne, flcm.get and render results all carry. Got " + showValue(id) + ".",
    );
  }
  const changes = compileDeltaTrees(rest as EditDelta, entryCall(index));
  rejectNonDeltaWords(changes, entryCall(index));
  return { id, changes };
}

// Resolve concurrently — reading a node by id is read-only, and a batch of ten shouldn't pay ten
// serial round trips. Every resolution runs to completion before anything is raised; a slot is left
// empty exactly where the ledger holds that entry's failure.
async function resolveEntryNodes(ledger: BatchLedger, batch: readonly BatchEntry[]): Promise<(SceneNode | undefined)[]> {
  const nodes: (SceneNode | undefined)[] = [];
  await Promise.all(
    batch.map(async (entry, i) => {
      if (ledger.failed(i)) return; // a malformed entry's node is not a question worth asking
      try {
        // Through the target resolver's id branch, not a key scan: an entry's `id` IS live
        // identity, so a string that happens to also be someone's flcm/key is not a question here.
        nodes[i] = await resolveTarget({ id: entry.id });
        ledger.resolved(i, nodes[i]!);
      } catch (err) {
        ledger.record(i, err);
      }
    }),
  );
  return nodes;
}

// Two entries naming one node is refused, never merged. Last-wins would silently drop a delta the
// agent wrote — and two entries for one id are a slip in whatever built the list, not an intentional
// merge. The remedy is one entry carrying both deltas.
function assertOneEntryPerNode(ledger: BatchLedger, nodes: readonly (SceneNode | undefined)[]): void {
  const firstSeen: Record<string, number> = {};
  forEachLiveEntry(ledger, nodes.length, (i) => {
    const node = nodes[i] as SceneNode;
    const first = firstSeen[node.id];
    if (first === undefined) {
      firstSeen[node.id] = i;
      return;
    }
    throw new FlcmError(
      "authoring",
      "entry [" + first + "] edits this layer too. Merge the two deltas into one entry — a batch edits each layer once.",
      { node: { type: node.type, name: node.name, id: node.id } },
    );
  });
}

/**
 * Every INSTANCE entry's targets, resolved: the instance's current main component (kept per entry
 * — the one instance fact the gate takes as a handle) and every target its words name. Read-only
 * and document-local (no host round trip), so it runs concurrently. A slot stays null for an entry
 * whose delta names no component word — the ordinary case.
 */
async function resolveEntryInstanceTargets(
  ledger: BatchLedger, plans: readonly (EditPlan | undefined)[], targets: ResolvedTargets,
): Promise<(any | null)[]> {
  const currents: (any | null)[] = [];
  await Promise.all(
    plans.map(async (plan, i) => {
      currents[i] = null;
      if (ledger.failed(i) || !plan || !plan.instanceWords) return;
      try {
        currents[i] = await resolveInstanceEditTargets(plan.node, plan.instanceWords, targets);
      } catch (err) {
        ledger.record(i, err);
      }
    }),
  );
  return currents;
}

/** Every COMPONENT entry's targets — the instance-swap defaults its definition words name. */
async function resolveEntryBoundInstanceMains(
  ledger: BatchLedger, plans: readonly (EditPlan | undefined)[],
): Promise<(any | null)[]> {
  const mains: (any | null)[] = [];
  await Promise.all(
    plans.map(async (plan, i) => {
      mains[i] = null;
      const refs = plan?.componentWords?.componentPropertyReferences as Record<string, unknown> | undefined;
      if (ledger.failed(i) || !plan || plan.node.type !== "INSTANCE" || refs == null || refs.componentId == null) return;
      try {
        mains[i] = await (plan.node as InstanceNode).getMainComponentAsync();
      } catch (err) {
        ledger.record(i, err);
      }
    }),
  );
  return mains;
}

/**
 * Every INSTANCE entry's component half, planned against the document as it stands. Run by
 * prepare as the HINT (which fonts the override deltas and slot content need loaded) and by the
 * gate for the plans that land (instance.ts on the two halves).
 */
function planEntryInstances(
  ledger: BatchLedger, plans: readonly (EditPlan | undefined)[], currents: readonly (any | null)[], planning: InstancePlanning,
): (InstanceEditPlan | undefined)[] {
  const instances: (InstanceEditPlan | undefined)[] = [];
  forEachLiveEntry(ledger, plans.length, (i) => {
    const plan = plans[i];
    if (plan && plan.instanceWords) instances[i] = planInstanceEdit(plan.node, plan.instanceWords, currents[i], planning, entryCall(i));
  });
  return instances;
}

/**
 * Every COMPONENT entry's definition/binding half, planned against the live component — gate only.
 *
 * Three passes, because a property this batch ADDS is the one cross-entry dependency with a single
 * reading: its name exists nowhere on the canvas, so an entry binding a layer to it can only mean the
 * new one. Its adds are planned first, the bindings against them next, and only then each add's
 * default — read off the layers those bindings name, as they will stand once their own entries land.
 */
function planEntryComponents(
  ledger: BatchLedger, plans: readonly (EditPlan | undefined)[],
  instances: readonly (InstanceEditPlan | undefined)[], mains: readonly (any | null)[],
): (ComponentEditPlan | undefined)[] {
  const adds: Map<string, AddedDefinition>[] = [];
  const addsByOwner = new Map<any, Map<string, AddedDefinition>>();
  forEachLiveEntry(ledger, plans.length, (i) => {
    const plan = plans[i];
    if (!plan || !plan.componentWords) return;
    adds[i] = planAddedDefinitions(plan.node, plan.componentWords, entryCall(i));
    if (adds[i].size) addsByOwner.set(plan.node, adds[i]);
  });
  const bindings: (ComponentBindingEditPlan | undefined)[] = [];
  forEachLiveEntry(ledger, plans.length, (i) => {
    const refs = plans[i]?.componentWords?.componentPropertyReferences;
    if (refs !== undefined) bindings[i] = prepareComponentBindingEdit(plans[i]!.node, refs, entryCall(i), (owner) => addsByOwner.get(owner));
  });
  const binderValue = (j: number, field: string) => projectedBinderValue(field, plans[j]!.node, plans[j]!, instances[j], mains[j], entryCall(j));
  const bindersOf = (add: AddedDefinition): PropertyBinder[] => {
    const binders: PropertyBinder[] = [];
    bindings.forEach((binding, j) => {
      for (const write of binding?.writes ?? []) {
        if (write.add !== add || ledger.failed(j)) continue;
        binders.push({ layer: describeBinder(plans[j]!.node.name, "entry " + j), value: binderValue(j, write.field) });
      }
    });
    return binders;
  };
  const components: (ComponentEditPlan | undefined)[] = [];
  forEachLiveEntry(ledger, plans.length, (i) => {
    const plan = plans[i];
    if (!plan || !plan.componentWords) return;
    const words = plan.componentWords;
    const component: ComponentEditPlan = {};
    if (words.description !== undefined || words.propertyDefinitions !== undefined) {
      component.definitions = planComponentDefinitionEdit(plan.node, words, entryCall(i), adds[i], bindersOf);
    }
    if (bindings[i]) component.binding = bindings[i];
    components[i] = component;
  });
  settleEntryBoundDefaults(ledger, plans, instances, bindings, components, binderValue);
  return components;
}

/**
 * The defaults of the existing properties this batch binds, judged across every entry at once: two
 * entries binding one property are binders of the same default, and an entry that edits or rebinds a
 * layer already bound to it changes what that layer contributes. Each write rides on the entry whose
 * binding settled it; a refusal is that entry's.
 */
function settleEntryBoundDefaults(
  ledger: BatchLedger, plans: readonly (EditPlan | undefined)[], instances: readonly (InstanceEditPlan | undefined)[],
  bindings: readonly (ComponentBindingEditPlan | undefined)[], components: (ComponentEditPlan | undefined)[], binderValue: (j: number, field: string) => boolean | string,
): void {
  const existing: ExistingPropertyBinding[] = [];
  const entryOf = new Map<ExistingPropertyBinding, number>();
  const rewired = new Map<any, ComponentBindingEditPlan>();
  const entryAt = new Map<any, number>();
  forEachLiveEntry(ledger, plans.length, (j) => {
    entryAt.set(plans[j]!.node, j);
    const binding = bindings[j];
    if (!binding) return;
    rewired.set(plans[j]!.node, binding);
    for (const one of existingPropertyBindings(binding, describeBinder(plans[j]!.node.name, "entry " + j), entryCall(j), (field) => binderValue(j, field))) {
      existing.push(one);
      entryOf.set(one, j);
    }
  });
  const writes = settleExistingPropertyDefaults(existing, {
    leaves: (node, wire) => !!rewired.get(node)?.writes.some((write) => write.wire === wire),
    shows: (node, field) => {
      const j = entryAt.get(node);
      return j === undefined ? undefined : editedBinderValue(field, plans[j]!, instances[j]);
    },
  }, (binding, cause) => ledger.record(entryOf.get(binding)!, cause));
  for (const write of writes) {
    const component = components[entryOf.get(write.by)!]!;
    (component.defaults ??= []).push(write);
  }
}

/**
 * A batch that both re-declares a component's properties and NAMES one of them from another entry
 * is refused, naming both entries.
 *
 * Every other cross-entry dependency in a batch has a defined answer (the schedule, edit-apply.ts,
 * and the parent projection). This one doesn't: the naming entry resolved a NAME against the
 * definitions on the canvas, and the definition entry may be renaming or deleting exactly that
 * property — so the batch would either wire a layer to a property that is about to move or refuse a
 * name that is about to exist, depending on an order the agent never stated. Two calls say it
 * unambiguously, and that is what the refusal asks for.
 *
 * Two entry shapes name a property: a sublayer's `componentPropertyReferences`, and an INSTANCE's
 * `componentProperties`. The second is not a lesser case — the appliers run the instance's
 * setProperties BEFORE the definition writes, so a batch deleting a property while an instance sets
 * it would land the value and then throw it away, silently.
 */
function assertNoDefinitionBindingCrossReference(
  ledger: BatchLedger, plans: readonly (EditPlan | undefined)[],
  components: readonly (ComponentEditPlan | undefined)[], instances: readonly (InstanceEditPlan | undefined)[],
): void {
  for (let declarer = 0; declarer < plans.length; declarer++) {
    const definitions = components[declarer] && components[declarer]!.definitions;
    const declarerPlan = plans[declarer];
    if (!definitions || !declarerPlan || ledger.failed(declarer)) continue;
    // Adds alone are no hazard: a new name resolves to nothing on the canvas, so a binding to it has
    // one reading (planEntryComponents), and every other name it could bind is one adds don't touch.
    if (!definitions.deletes.length && !definitions.renames.length) continue;
    for (let namer = 0; namer < plans.length; namer++) {
      const namerPlan = plans[namer];
      if (namer === declarer || !namerPlan || ledger.failed(namer)) continue;
      const named = definitionsNamedByEntry(namerPlan, components[namer], instances[namer]);
      if (!named || named.owner !== definitionOwnerOf(declarerPlan.node)) continue;
      ledger.record(
        namer,
        new FlcmError(
          "authoring",
          named.what + " of " + describeNodeIdentity(declarerPlan.node) +
            ", whose `propertyDefinitions` entry [" + declarer + "] is changing in the same batch — the two would have to run in an order this call never states. " +
            "Split them: rename or delete in one call, " + named.instead + " in the next.",
        ),
      );
    }
  }
}

/**
 * Whose declarations an entry depends on, and how it says so — undefined for an entry that names no
 * property at all. Answered by definition OWNER: a layer inside a variant binds against the SET's
 * properties, and so does an instance of that variant, which is the node a `propertyDefinitions`
 * entry has to name.
 */
function definitionsNamedByEntry(
  plan: EditPlan, component: ComponentEditPlan | undefined, instance: InstanceEditPlan | undefined,
): { owner: any; what: string; instead: string } | undefined {
  // A binding to a property this batch ADDS names nothing on the canvas, so no rename or delete can
  // move it — only a write resolved against a live name depends on the order.
  if (component && component.binding && component.binding.writes.some((write) => !write.add)) {
    const around = editableComponentOwnerOf(plan.node, false);
    return around ? { owner: definitionOwnerOf(around), what: "binds a layer to a property", instead: "bind the layers" } : undefined;
  }
  if (instance && instance.namesDeclaredPropertiesOf) {
    return {
      owner: definitionOwnerOf(instance.namesDeclaredPropertiesOf),
      what: "sets `componentProperties` on an instance",
      instead: "set the instance's values",
    };
  }
  return undefined;
}

/**
 * An entry aimed INSIDE an instance another entry is re-pointing is refused, naming both.
 *
 * A swap or a variant change rebuilds the instance's sublayers, so the node the inner entry
 * resolved and gated against is detached by the time the batch's write passes reach it — and Figma
 * keeps accepting writes on a detached node (the same hazard assertNodeStillOnCanvas calls out
 * for a deleted one), so the batch would report success for a write that landed nowhere. The path
 * that survives is the instance entry's own `overrides`, which are re-acquired after the retarget.
 *
 * Runs in the GATE, like every other refusal that reads the live tree.
 */
function assertNoEntryInsideRetargetedInstance(
  ledger: BatchLedger, plans: readonly (EditPlan | undefined)[], instances: readonly (InstanceEditPlan | undefined)[],
): void {
  for (let host = 0; host < plans.length; host++) {
    const instance = instances[host];
    const hostPlan = plans[host];
    if (!instance || !instance.retargets || !hostPlan || ledger.failed(host)) continue;
    for (let inner = 0; inner < plans.length; inner++) {
      const innerPlan = plans[inner];
      if (inner === host || !innerPlan || ledger.failed(inner)) continue;
      if (!isInsideInstance(innerPlan.node, hostPlan.node)) continue;
      ledger.record(
        inner,
        new FlcmError(
          "authoring",
          "this layer sits inside " + describeNodeIdentity(hostPlan.node) +
            ", the instance entry [" + host + "] re-points — that swap rebuilds its sublayers, so this edit would land on a layer no longer in the tree. " +
            "Move it into entry [" + host + "]'s own `overrides`, keyed by the sublayer's component-relative path.",
          { node: { type: innerPlan.node.type, name: innerPlan.node.name, id: innerPlan.node.id } },
        ),
      );
    }
  }
}

// Is `node` inside `host`? A sublayer answers by its composite id (`I<host>;<path>`, one leading `I`
// however deep — core's rule), anything else by the parent chain.
function isInsideInstance(node: SceneNode, host: SceneNode): boolean {
  if (node.id.startsWith(sublayerPrefix(host.id))) return true;
  for (let p = node.parent as BaseNode | null; p; p = p.parent) if (p === host) return true;
  return false;
}

/**
 * Every entry's layout delta, by node id — so an entry can be judged against the ancestors the
 * batch is about to produce rather than the ones on the canvas.
 *
 * This is what makes "order doesn't matter" true on the VALIDATION side; the schedule is the apply
 * side of the same promise. Without it the gates answer from the pre-batch canvas
 * in both directions: a child set to `"fill"` under a parent the batch turns into a row is refused
 * though it would have worked, and — worse, because this surface is fail-loud — a child set to
 * `"fill"` under a parent the batch turns FREE-FORM is accepted and then silently never honored.
 */
function layoutDeltasByNodeId(plans: readonly (EditPlan | undefined)[]): BatchLayoutDeltas {
  const byId: BatchLayoutDeltas = {};
  for (const plan of plans) if (plan && plan.patch.layout) byId[plan.node.id] = plan.patch.layout;
  return byId;
}

// Every entry's compile of its whole delta, in ONE synchronous turn, so all of them see a single
// canvas instant rather than one instant per entry. Prepare runs it for the hint, the gate for real.
function compileEntries(ledger: BatchLedger, nodes: readonly (SceneNode | undefined)[], batch: readonly BatchEntry[]): (EditPlan | undefined)[] {
  const compiled: (EditPlan | undefined)[] = [];
  forEachLiveEntry(ledger, batch.length, (i) => {
    compiled[i] = compileEditPlan(nodes[i] as SceneNode, batch[i].changes, entryCall(i));
  });
  return compiled;
}

/**
 * flcm.editMany(entries) — apply a set of per-node deltas as ONE atomic call. Each entry is
 * `{ id, ...changes }`: the live node id, plus exactly the delta `flcm.edit` takes. Every id
 * resolves and every delta validates before the first canvas write; a rejection names every failing
 * entry and leaves the canvas untouched. Returns each entry's updated Handle, in entry order.
 */
// A single expression on purpose: the queue slot is reserved before editMany() can possibly yield,
// which is the lock's invocation-order guarantee (see enterMutatingVerb) — don't add work above it.
export function editMany(entries: EditEntry[]): Promise<Handle[]> {
  return enterMutatingVerb(
    "editMany",
    async () => {
      assertBatchShape(entries);
      // Snapshot the array itself, not just its contents: prepare awaits, and the caller's own code
      // can run in between. A batch that grew or shrank underneath us would mint handles for a set
      // nobody validated. Entries are read-only from here on; the objects inside are the caller's
      // and are only ever read.
      const raw = entries.slice();
      const ledger = createBatchLedger(raw.length);
      // Sized to the CALLER's count up front, and left with a hole wherever an entry failed: every
      // stage below addresses entries by index, and a length that shrank with a trailing bad entry
      // would misreport the batch's size.
      const batch: BatchEntry[] = new Array(raw.length);
      forEachLiveEntry(ledger, raw.length, (i) => { batch[i] = compileBatchEntry(raw[i], i); });
      const nodes = await resolveEntryNodes(ledger, batch);
      assertOneEntryPerNode(ledger, nodes);
      // The HINT compiles: what each entry needs loaded if the document stays as it is. Every
      // decision they make is made again in the gate, against the document at the seal.
      const hints = compileEntries(ledger, nodes, batch);
      const targets = createResolvedTargets();
      const currents = await resolveEntryInstanceTargets(ledger, hints, targets);
      const mains = await resolveEntryBoundInstanceMains(ledger, hints);
      const instances = planEntryInstances(ledger, hints, currents, { targets });
      // The shape, resolve and hint stages all report together. The gate cannot join them: it
      // needs the resources, and a batch already known to be doomed must not spend a font load
      // and an image fetch to find its remaining faults.
      ledger.rejectIfAny();
      const plans = hints as EditPlan[]; // dense: rejectIfAny threw unless every stage filled its slot
      // The override deltas ride the SAME load — each is a text/image edit of one sublayer, and the
      // batch owes one round trip however many of them there are.
      let dependencies = NO_READ_DEPENDENCIES;
      const loaded = await loadEditResources(
        [...plans, ...instances.flatMap((instance) => (instance ? instance.overrides.map((o) => o.plan) : []))],
        instances.flatMap((instance) => (instance ? [instance.needs] : [])),
        (tokens) => {
          dependencies = captureReadDependencies(plans.flatMap((plan, i) => deriveConcurrentEditObligations(plan, instances[i], tokens, liveObligationSite(plan.node), entryCall(i))));
        },
      );
      // What each entry's layer and override paths inherit from: the order a main component's edit
      // and an instance layer restating its old value land in.
      const inherited = await resolveInstanceMains(plans.flatMap((plan, i) => [
        plan.node,
        ...(instances[i]?.overrides ?? []).map((o) => ({ id: liveSublayerId(plan.node.id, o.path), type: o.plan.node.type })),
      ]));
      return { batch, nodes, targets, currents, mains, loaded, dependencies, inherited };
    },
    // Gate — every decision that reads the document, for every entry, against the document as it
    // stands at the seal. The batch is what makes this load-bearing: entry 0's node was resolved
    // before every later entry's resolution and the whole batch's font/image round trip, and the
    // user has the document open across all of it. The ledger runs here too, so one rejection
    // still names every failing entry.
    ({ batch, nodes, targets, currents, mains, loaded, dependencies, inherited }) => {
      const ledger = createBatchLedger(batch.length);
      forEachLiveEntry(ledger, batch.length, (i) => assertNodeStillOnCanvas(nodes[i] as SceneNode, entryCall(i)));
      const compiled = compileEntries(ledger, nodes, batch);
      const instances = planEntryInstances(ledger, compiled, currents, { targets, gate: loaded });
      const components = planEntryComponents(ledger, compiled, instances, mains);
      assertNoEntryInsideRetargetedInstance(ledger, compiled, instances);
      assertNoDefinitionBindingCrossReference(ledger, compiled, components, instances);
      const deltas = layoutDeltasByNodeId(compiled);
      const authorized: AuthorizedEditPlan[] = [];
      forEachLiveEntry(ledger, batch.length, (i) => {
        // The root's layout gate reads the container the entry LEAVES BEHIND (a swap re-points the
        // instance before its own layout words land).
        authorized[i] = authorizeEditPlan(compiled[i] as EditPlan, loaded, entryCall(i), { deltas, becomes: instances[i]?.becomesContainer });
      });
      ledger.rejectIfAny();
      const plans = authorized;
      // Every geometry write in the batch: what a realize-only measure in any entry can wait on.
      const writes = compiled.flatMap((plan, i) => [
        ...geometryWritesOf(plan!.node, plan!.patch),
        ...(instances[i] ? instanceGeometryWrites(plan!.node, plan!.patch, instances[i]!) : []),
      ]);
      // Every main component an entry edits: what an instance layer elsewhere in the batch inherits.
      const mainsNow = provenInstanceMains(inherited, instanceStillShows);
      const defines = new Set(compiled.flatMap((plan) => [...definitionsEditedAt(plan!.node)]));
      // Every entry's whole delta is owed, judged against the parents the batch leaves behind.
      forEachLiveEntry(ledger, batch.length, (i) => {
        const plan = compiled[i]!;
        const parent = plan.node.parent;
        const site = liveObligationSite(plan.node, parent ? deltas[parent.id] : undefined);
        const subject = entryCall(i);
        const owed = obligationsOnTarget(deriveEditObligations(plan, instances[i], loaded, site), { node: plan.node }, subject);
        recordObligations(owed);
        gateCallObligations({
          obligations: owed,
          dependencies,
          checks: [
            ...withoutRetargetHeldChecks(realizeOnlyChecksOf(plan, plans[i].realizeOnly, loaded, site, subject, plans[i].context), instances[i]),
            ...(instances[i] ? overrideRealizeOnlyChecks(instances[i]!.overrides, loaded, subject) : []),
          ],
          writes,
          projection: deltas,
          defines,
          mains: mainsNow,
        }, subject);
      });
      ledger.rejectIfAny();
      assertNoContradictoryWords(obligationsInCall(), SUBJECT);
      const entries: EditApplyEntry[] = plans.map((plan, i) => ({
        node: plan.node, plan, instance: instances[i], component: components[i], site: { path: entryCall(i) }, tag: "[" + i + "]",
      }));
      // Per operation across the whole batch, against every entry's recorded words (edit-apply.ts).
      const schedule = scheduleEditEntries(entries, SUBJECT, { mains: mainsNow });
      return { entries, schedule, resources: gateEditResources(loaded, instances.flatMap((instance) => (instance ? [instance.needs] : [])), SUBJECT) };
    },
    // Apply — the sealed span: every entry's writes, no awaits, one undo step for the set. ONE walk
    // for the batch's slot content (see beginRenderWalk): a key is unique across the set as it is
    // across a render, and every entry's content settles its percents together.
    ({ entries, schedule, resources }, span) => {
      runEditOperations(entries, schedule, beginRenderWalk({ ...resources, span }));
      return () => entries.map((entry) => mintHandle(entry.node));
    },
  );
}
