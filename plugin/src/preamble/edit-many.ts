// editMany — the atomic batch form of `edit`. It exists for ONE thing a caller loop cannot build:
// set-level atomicity. Validation lives inside a verb, so `for (const e of entries) await edit(…)`
// discovers entry 4's invalid delta only after entries 1–3 have already mutated the canvas — each
// call atomic, the set not. This validates every entry before applying any, and rejects naming
// EVERY failing entry, so the agent fixes the whole batch in one pass. One undo step is the
// secondary purchase: the user steps back over the nudge they asked for, not over nine of them.
//
// It is orchestration over edit-plan.ts's staged pipeline (see that module's header for the stages and
// why their order is the contract). Nothing here compiles or applies a delta itself: a second
// application path is exactly what invariant 1 forbids. Four things ARE this module's own, and
// each is a consequence of the set being the unit rather than the entry:
//
//   • the LEDGER — a failure is recorded against its entry and the batch keeps going, so one
//     rejection names every offender ACROSS stages, not just the ones that failed together
//   • the apply ORDER — ancestors before descendants (see applyOrderShallowestFirst)
//   • the apply PASSES — every entry finishes each of edit's apply stages before any entry starts
//     the next, so nothing measures a canvas another entry is still writing to (see the seal)
//   • the PROJECTION — an entry whose parent this same batch is editing is judged against the
//     parent the batch will produce, not the one on the canvas (see parentDeltasByNodeId)
//
// It takes the mutation lock ONCE, via a single enterMutatingVerb expression, and drives the
// commit-free internal appliers — never the public `edit`, which would shatter the batch into one
// undo boundary per entry (invariant 4).

import { Handle, Target } from "./ir.js";
import { resolveTarget } from "./read.js";
import { enterMutatingVerb } from "./mutation-lock.js";
import { mintHandle, resolvePercents, beginRenderWalk, BatchLayoutDeltas } from "./bridge.js";
import { rejectUnknownKeys } from "./validate.js";
import {
  EditPlan, rejectNonDeltaWords, compileEditPlan, loadEditResources, assertEditPlanStillApplies,
  openEditPlanApply, applyEditPlanWrites, settleEditPlanSizes, settleEditPlanPositions,
} from "./edit-plan.js";
import {
  prepareInstanceEditPlan, assertOverridePlansStillApply, applyInstanceRetarget, applyInstanceOverrides, InstanceEditPlan,
} from "./instance.js";
import { prepareComponentEditPlan, applyComponentDefinitionEdit, applyComponentBindingEdit, ComponentEditPlan } from "./component-edit.js";
import { componentAncestorOf } from "./component.js";
import { definitionOwnerOf } from "./identity.js";
import type { EditEntry, EditManyScope } from "./schema.js";

const SUBJECT = "flcm.editMany";

const ENTRY_KEYS = ["target", "changes"] as const;
const SCOPE_KEYS = ["within"] as const;
// Tie the runtime allow-lists to the types they mirror (read.ts does the same for FindQuery): a
// field added to either interface but not listed here fails typecheck, so the fail-loud gate can't
// silently start rejecting a legitimate new one.
type _EntryKeysCoverEditEntry = keyof EditEntry extends (typeof ENTRY_KEYS)[number] ? true : never;
type _ScopeKeysCoverEditManyScope = keyof EditManyScope extends (typeof SCOPE_KEYS)[number] ? true : never;
const _entryKeysExhaustive: _EntryKeysCoverEditEntry = true;
const _scopeKeysExhaustive: _ScopeKeysCoverEditManyScope = true;
void _entryKeysExhaustive;
void _scopeKeysExhaustive;

const ENTRY_KEY_SET: ReadonlySet<string> = new Set(ENTRY_KEYS);
const SCOPE_KEY_SET: ReadonlySet<string> = new Set(SCOPE_KEYS);

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
  record(index: number, err: unknown): void;
  failed(index: number): boolean;
  rejectIfAny(): void;
}

function createBatchLedger(total: number): BatchLedger {
  const failures: (string | undefined)[] = [];
  let count = 0;
  return {
    record(index, err) {
      if (failures[index] !== undefined) return;
      failures[index] = messageOf(err);
      count++;
    },
    failed(index) {
      return failures[index] !== undefined;
    },
    rejectIfAny() {
      if (!count) return;
      const lines: string[] = [];
      for (let i = 0; i < total; i++) if (failures[i] !== undefined) lines.push("  [" + i + "] " + failures[i]);
      throw new Error(
        SUBJECT + ": " + count + " of " + total + " entries were rejected, so NOTHING was applied — " +
          "the batch is all-or-nothing. Fix every entry below and re-run it.\n" + lines.join("\n"),
      );
    },
  };
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

// ---- prepare-phase stages, each over the WHOLE batch ----

function assertBatchShape(entries: unknown, scope: EditManyScope | undefined): void {
  if (!Array.isArray(entries)) {
    throw new Error(
      SUBJECT + ": the first argument is an array of { target, changes } entries — got " + JSON.stringify(entries) +
        ". To nudge a single node, use flcm.edit(target, changes).",
    );
  }
  if (!entries.length) {
    throw new Error(SUBJECT + ": the entries array is empty — nothing to apply (an empty batch would still mint an undo step).");
  }
  if (scope != null) rejectUnknownKeys(scope, SCOPE_KEY_SET, SUBJECT + "'s scope");
}

// The pure, document-blind stage: it runs for every entry before a single node is resolved, so a
// misspelled word reads as "unknown prop" no matter what it targets (invariant 2).
function assertEntryVocabulary(entry: EditEntry): void {
  rejectUnknownKeys(entry, ENTRY_KEY_SET, SUBJECT + "'s entry");
  rejectNonDeltaWords(entry.changes, SUBJECT);
}

// Resolve concurrently — target resolution is read-only, and a batch of ten shouldn't pay ten
// serial round trips. Every resolution runs to completion before anything is raised; a slot is left
// empty exactly where the ledger holds that entry's failure.
async function resolveEntryTargets(
  ledger: BatchLedger, entries: readonly EditEntry[], within: Target | undefined,
): Promise<(SceneNode | undefined)[]> {
  const nodes: (SceneNode | undefined)[] = [];
  await Promise.all(
    entries.map(async (entry, i) => {
      if (ledger.failed(i)) return; // a malformed entry's target is not a question worth asking
      try {
        nodes[i] = await resolveTarget(entry.target, within);
      } catch (err) {
        ledger.record(i, err);
      }
    }),
  );
  return nodes;
}

// Two entries naming one node is refused, never merged. Last-wins would silently drop a delta the
// agent wrote — and the two are usually a mistake (a key and an id for the same node), not an
// intentional merge. The remedy is one entry carrying both deltas.
function assertOneEntryPerNode(ledger: BatchLedger, nodes: readonly (SceneNode | undefined)[]): void {
  const firstSeen: Record<string, number> = {};
  forEachLiveEntry(ledger, nodes.length, (i) => {
    const node = nodes[i] as SceneNode;
    const first = firstSeen[node.id];
    if (first === undefined) {
      firstSeen[node.id] = i;
      return;
    }
    throw new Error(
      "resolves to the same node as entry [" + first + "]: " + JSON.stringify(node.name) + " (id " +
        JSON.stringify(node.id) + "). Merge the two deltas into one entry — a batch applies each node once.",
    );
  });
}

/**
 * Every INSTANCE entry's component half, resolved. Read-only and document-local (no host round
 * trip), so it runs concurrently and joins the COMPILE ledger group: a bad property name and a
 * misspelled word are reported together, and neither costs the batch its font/image load.
 *
 * A slot stays empty for an entry whose delta names no component word — the ordinary case.
 */
async function resolveEntryInstancePlans(
  ledger: BatchLedger, plans: readonly (EditPlan | undefined)[],
): Promise<(InstanceEditPlan | undefined)[]> {
  const instances: (InstanceEditPlan | undefined)[] = [];
  await Promise.all(
    plans.map(async (plan, i) => {
      if (ledger.failed(i) || !plan || !plan.instanceWords) return;
      try {
        instances[i] = await prepareInstanceEditPlan(plan.node, plan.instanceWords, SUBJECT);
      } catch (err) {
        ledger.record(i, err);
      }
    }),
  );
  return instances;
}

/**
 * Every COMPONENT entry's definition/binding half, resolved. Same group as the instance plans above
 * and for the same reasons: read-only, document-local, no host round trip.
 */
async function resolveEntryComponentPlans(
  ledger: BatchLedger, plans: readonly (EditPlan | undefined)[],
): Promise<(ComponentEditPlan | undefined)[]> {
  const components: (ComponentEditPlan | undefined)[] = [];
  await Promise.all(
    plans.map(async (plan, i) => {
      if (ledger.failed(i) || !plan || !plan.componentWords) return;
      try {
        components[i] = await prepareComponentEditPlan(plan.node, plan.componentWords, SUBJECT);
      } catch (err) {
        ledger.record(i, err);
      }
    }),
  );
  return components;
}

/**
 * A batch that both re-declares a component's properties and NAMES one of them from another entry
 * is refused, naming both entries.
 *
 * Every other cross-entry dependency in a batch has a defined answer (see applyOrderShallowestFirst
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
    if (!definitions.deletes.length && !definitions.changes.length && !definitions.adds.length) continue;
    for (let namer = 0; namer < plans.length; namer++) {
      const namerPlan = plans[namer];
      if (namer === declarer || !namerPlan || ledger.failed(namer)) continue;
      const named = definitionsNamedByEntry(namerPlan, components[namer], instances[namer]);
      if (!named || named.owner !== definitionOwnerOf(declarerPlan.node)) continue;
      ledger.record(
        namer,
        new Error(
          named.what + " of " + JSON.stringify(declarerPlan.node.name) + " (id " + JSON.stringify(declarerPlan.node.id) +
            "), whose `propertyDefinitions` entry [" + declarer + "] is changing in the same batch — the two would have to run in an order this call never states. " +
            "Split them: declare the properties in one call, " + named.instead + " in the next.",
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
  if (component && component.binding) {
    const around = componentAncestorOf(plan.node);
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
 * keeps accepting writes on a detached node (the same hazard assertEditPlanStillApplies calls out
 * for a deleted one), so the batch would report success for a write that landed nowhere. The path
 * that survives is the instance entry's own `overrides`, which are re-acquired after the retarget.
 *
 * Runs in the compile ledger group: it is document-local and costs no round trip, so it reports
 * alongside every other prepare fault instead of after the batch has paid for its font load.
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
        new Error(
          "sits inside " + JSON.stringify(hostPlan.node.name) + " (id " + JSON.stringify(hostPlan.node.id) +
            "), the instance entry [" + host + "] re-points — that swap rebuilds these sublayers, so this write would land on a node no longer in the tree. " +
            "Move it into entry [" + host + "]'s own `overrides`, keyed by the sublayer's component-relative path.",
        ),
      );
    }
  }
}

/**
 * An entry aimed INSIDE a slot another entry FILLS is refused, naming both.
 *
 * A fill replaces the slot's content wholesale — every current child is removed — so by the time
 * the batch's override pass runs, the node the inner entry resolved and wrote to in an earlier
 * stage is gone. Figma keeps accepting writes on a removed node (the same hazard the retarget rule
 * above and assertEditPlanStillApplies call out), so without this the batch would report success
 * and hand back a Handle minted from a corpse. The remedy is not an order: the layer the fill
 * installs is a different node from the one the entry names, so its words belong on the spec.
 *
 * The single-delta form of this contradiction — one entry stating both the fill and a path inside
 * it — is refused in instance.ts, where the override set is resolved.
 *
 * Runs in the compile ledger group, like every other document-local cross-entry refusal.
 */
function assertNoEntryInsideFilledSlot(
  ledger: BatchLedger, plans: readonly (EditPlan | undefined)[], instances: readonly (InstanceEditPlan | undefined)[],
): void {
  for (let host = 0; host < plans.length; host++) {
    const instance = instances[host];
    const hostPlan = plans[host];
    if (!instance || !hostPlan || ledger.failed(host)) continue;
    // A RETARGETING entry's override plans were compiled against the incoming component's
    // definition nodes, not against anything on the canvas — an entry inside that instance is
    // already refused by assertNoEntryInsideRetargetedInstance, on the stronger ground that the
    // whole sublayer tree goes.
    if (instance.retargets) continue;
    for (const slot of instance.overrides) {
      if (!slot.slotContent) continue;
      for (let inner = 0; inner < plans.length; inner++) {
        const innerPlan = plans[inner];
        if (inner === host || !innerPlan || ledger.failed(inner)) continue;
        if (!isUnder(innerPlan.node, slot.plan.node)) continue;
        ledger.record(
          inner,
          new Error(
            "sits inside the slot at " + JSON.stringify(slot.path) + " of " + JSON.stringify(hostPlan.node.name) +
              " (id " + JSON.stringify(hostPlan.node.id) + "), which entry [" + host + "] FILLS in the same batch — that fill " +
              "removes the slot's current content, so this write would land on a node no longer in the tree. " +
              "State these words on the spec entry [" + host + "] fills the slot with.",
          ),
        );
      }
    }
  }
}

// Is `node` a descendant of `ancestor`? The ancestor is a live node the batch resolved, so the
// parent chain is the whole answer — no composite-id reasoning needed.
function isUnder(node: SceneNode, ancestor: SceneNode): boolean {
  for (let p = node.parent as BaseNode | null; p; p = p.parent) if (p === (ancestor as BaseNode)) return true;
  return false;
}

// Is `node` inside `host`? A sublayer answers by its composite id (`I<host>;<path>`, one leading `I`
// however deep — core's rule), anything else by the parent chain.
function isInsideInstance(node: SceneNode, host: SceneNode): boolean {
  const prefix = (host.id.charAt(0) === "I" ? host.id : "I" + host.id) + ";";
  if (node.id.indexOf(prefix) === 0) return true;
  for (let p = node.parent as BaseNode | null; p; p = p.parent) if (p === host) return true;
  return false;
}

/**
 * Every entry's layout delta, by node id — so an entry can be judged against the ancestors the
 * batch is about to produce rather than the ones on the canvas.
 *
 * This is what makes "order doesn't matter" true on the VALIDATION side; applyOrderShallowestFirst
 * is only the apply side of the same promise. Without it the gates answer from the pre-batch canvas
 * in both directions: a child set to `"fill"` under a parent the batch turns into a row is refused
 * though it would have worked, and — worse, because this surface is fail-loud — a child set to
 * `"fill"` under a parent the batch turns FREE-FORM is accepted and then silently never honored.
 */
function layoutDeltasByNodeId(plans: readonly EditPlan[]): BatchLayoutDeltas {
  const byId: BatchLayoutDeltas = {};
  for (const plan of plans) if (plan.patch.layout) byId[plan.node.id] = plan.patch.layout;
  return byId;
}

// ---- apply ----

/**
 * Entry indices ordered ancestors-first, ties broken by the caller's own order.
 *
 * Invariant 3 — the applier owns application order, and in a batch that ordering spans the whole
 * set: a batch that makes a parent auto-layout and sets its child to `fill` must succeed in either
 * array order. Depth is what decides it, because every cross-entry dependency in a props-only batch
 * points the same way: a child's `fill`/`hug`/`N%` resolves against a parent whose layout mode and
 * size the batch may also be changing, and never the reverse.
 *
 * Read at the top of the sealed span, not in prepare: a node's depth is a live fact, and the
 * resource awaits sit between.
 */
function applyOrderShallowestFirst(plans: readonly EditPlan[]): number[] {
  const depths = plans.map((plan) => {
    let depth = 0;
    for (let p = plan.node.parent as BaseNode | null; p; p = p.parent) depth++;
    return depth;
  });
  return plans.map((_, i) => i).sort((a, b) => depths[a] - depths[b] || a - b);
}

/**
 * flcm.editMany(entries, scope?) — apply a set of per-target deltas as ONE atomic call. Every
 * target resolves and every delta validates before the first canvas write; a rejection names every
 * failing entry and leaves the canvas untouched. Optional `scope.within` narrows key resolution the
 * way `find`'s does (default: the current page). Returns each entry's updated Handle, in entry
 * order.
 */
// A single expression on purpose: the queue slot is reserved before editMany() can possibly yield,
// which is the lock's invocation-order guarantee (see enterMutatingVerb) — don't add work above it.
export function editMany(entries: EditEntry[], scope?: EditManyScope): Promise<Handle[]> {
  return enterMutatingVerb(
    "editMany",
    async () => {
      assertBatchShape(entries, scope);
      // Snapshot the array itself, not just its contents: prepare awaits, and the caller's own code
      // can run in between. A batch that grew or shrank underneath us would mint handles for a set
      // nobody validated. Entries are read-only from here on; the objects inside are the caller's
      // and are only ever read.
      const batch = entries.slice();
      const ledger = createBatchLedger(batch.length);
      forEachLiveEntry(ledger, batch.length, (i) => assertEntryVocabulary(batch[i]));
      // `within` resolves ONCE for the batch, not per entry: as a bare key it costs a document
      // scan, and N identical scans is the cost the batch verb exists to remove. Handed on as a
      // raw-id ref so each entry's own resolution is a lookup, and so a bad scope throws once,
      // plainly, instead of once per entry inside the aggregate.
      const scoped = scope && scope.within != null ? await resolveTarget(scope.within) : undefined;
      const within: Target | undefined = scoped ? { __flcmId: scoped.id } : undefined;
      const nodes = await resolveEntryTargets(ledger, batch, within);
      assertOneEntryPerNode(ledger, nodes);
      // Every compile runs in ONE synchronous turn after the resolves, so all of them see a single
      // canvas instant rather than one instant per entry.
      const compiled: (EditPlan | undefined)[] = [];
      forEachLiveEntry(ledger, batch.length, (i) => {
        compiled[i] = compileEditPlan(nodes[i] as SceneNode, batch[i].changes, SUBJECT);
      });
      const instances = await resolveEntryInstancePlans(ledger, compiled);
      const components = await resolveEntryComponentPlans(ledger, compiled);
      assertNoEntryInsideRetargetedInstance(ledger, compiled, instances);
      assertNoEntryInsideFilledSlot(ledger, compiled, instances);
      assertNoDefinitionBindingCrossReference(ledger, compiled, components, instances);
      // The document-blind, resolve and compile stages all report together. The seal-time gates
      // below cannot join them: they need the resources, and a batch already known to be doomed
      // must not spend a font load and an image fetch to find its remaining faults.
      ledger.rejectIfAny();
      const plans = compiled as EditPlan[]; // dense: rejectIfAny threw unless every stage filled its slot
      // The override deltas ride the SAME load — each is a text/image edit of one sublayer, and the
      // batch owes one round trip however many of them there are.
      const resources = await loadEditResources(
        [...plans, ...instances.flatMap((instance) => (instance ? instance.overrides.map((o) => o.plan) : []))],
        instances.flatMap((instance) => (instance ? [instance.needs] : [])),
      );
      // AFTER the batch's last await: the live gates, plus proof that each node still exists and
      // the facts its compile read survived the loads. The batch is what makes this load-bearing —
      // entry 0's node state was read before every later entry's resolution and the whole batch's
      // font/image round trip, and the user has the document open across all of it.
      const deltas = layoutDeltasByNodeId(plans);
      forEachLiveEntry(ledger, plans.length, (i) => {
        const instance = instances[i];
        // The root's layout gate reads the container the entry LEAVES BEHIND (a swap re-points the
        // instance before its own layout words land); a non-retargeting entry's override plans get
        // the same stage-4 pass here, where a stale sublayer costs the batch zero writes.
        assertEditPlanStillApplies(plans[i], SUBJECT, deltas, instance ? instance.becomesRowColumn : undefined);
        if (instance) assertOverridePlansStillApply(instance, SUBJECT);
      });
      ledger.rejectIfAny();
      return { plans, instances, components, resources };
    },
    // Apply — the sealed span: every entry's writes, no awaits, one undo step for the set.
    ({ plans, instances, components, resources }) => {
      // Every entry's failure builder BEFORE the first write of the batch: it snapshots the
      // identity the error will name, and entry 0's rename must not be what entry 0's own later
      // stage reports (see openEditPlanApply).
      const fails = plans.map((plan, i) => openEditPlanApply("editMany (entry " + i + ")", plan));
      const order = applyOrderShallowestFirst(plans);
      // Stage by stage across the WHOLE batch, not entry by entry. Within one entry `edit` already
      // orders producers before consumers; across entries only the batch can, and it must — an
      // entry that centers a hugging panel would otherwise read a width the entry editing that
      // panel's child is about to grow, and center it on the size it used to be.
      // An INSTANCE entry's component words BRACKET the node-local stages (see edit.ts): the
      // retarget first, so every later stage measures the tree this batch is producing, and the
      // overrides last, on sublayers re-acquired after it.
      for (const i of order) {
        const instance = instances[i];
        if (instance) applyInstanceRetarget(fails[i], plans[i].node, instance);
      }
      // A COMPONENT entry's definition words come before every entry's writes and its binding words
      // after them — the same bracket `edit` applies to one delta (see edit.ts), widened to the set.
      for (const i of order) {
        const component = components[i];
        if (component && component.definitions) applyComponentDefinitionEdit(fails[i], plans[i].node, component.definitions);
      }
      for (const i of order) applyEditPlanWrites(fails[i], plans[i], resources);
      for (const i of order) {
        const component = components[i];
        if (component && component.binding) applyComponentBindingEdit(fails[i], plans[i].node, component.binding);
      }
      for (const i of order) settleEditPlanSizes(fails[i], plans[i]);
      for (const i of order) settleEditPlanPositions(fails[i], plans[i]);
      // ONE walk for the batch's slot content (see beginRenderWalk): a key is unique across the set
      // as it is across a render, and every entry's content settles its percents together.
      const walk = beginRenderWalk(resources);
      for (const i of order) {
        const instance = instances[i];
        if (instance) applyInstanceOverrides(plans[i].node, instance, walk, "editMany (entry " + i + ")");
      }
      resolvePercents(walk);
      // Handles are minted only once every write has landed: a hug parent reflows when a child in
      // the same batch changes, so geometry read mid-batch would be a number about to move.
      return plans.map((plan) => mintHandle(plan.node));
    },
  );
}
