// editMany — the atomic batch form of `edit`. It exists for ONE thing a caller loop cannot build:
// set-level atomicity. Validation lives inside a verb, so `for (const e of entries) await edit(…)`
// discovers entry 4's invalid delta only after entries 1–3 have already mutated the canvas — each
// call atomic, the set not. This validates every entry before applying any, and rejects naming
// EVERY failing entry, so the agent fixes the whole batch in one pass. One undo step is the
// secondary purchase: the user steps back over the nudge they asked for, not over nine of them.
//
// It is orchestration over edit.ts's staged pipeline (see that module's header for the stages and
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
import { mintHandle, BatchLayoutDeltas } from "./bridge.js";
import { rejectUnknownKeys } from "./validate.js";
import {
  EditPlan, rejectNonDeltaWords, compileEditPlan, loadEditResources, assertEditPlanStillApplies,
  openEditPlanApply, applyEditPlanWrites, settleEditPlanSizes, settleEditPlanPositions,
} from "./edit.js";
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
      // The document-blind, resolve and compile stages all report together. The seal-time gates
      // below cannot join them: they need the resources, and a batch already known to be doomed
      // must not spend a font load and an image fetch to find its remaining faults.
      ledger.rejectIfAny();
      const plans = compiled as EditPlan[]; // dense: rejectIfAny threw unless every stage filled its slot
      const resources = await loadEditResources(plans);
      // AFTER the batch's last await: the live gates, plus proof that each node still exists and
      // the facts its compile read survived the loads. The batch is what makes this load-bearing —
      // entry 0's node state was read before every later entry's resolution and the whole batch's
      // font/image round trip, and the user has the document open across all of it.
      const deltas = layoutDeltasByNodeId(plans);
      forEachLiveEntry(ledger, plans.length, (i) => assertEditPlanStillApplies(plans[i], SUBJECT, deltas));
      ledger.rejectIfAny();
      return { plans, resources };
    },
    // Apply — the sealed span: every entry's writes, no awaits, one undo step for the set.
    ({ plans, resources }) => {
      // Every entry's failure builder BEFORE the first write of the batch: it snapshots the
      // identity the error will name, and entry 0's rename must not be what entry 0's own later
      // stage reports (see openEditPlanApply).
      const fails = plans.map((plan, i) => openEditPlanApply("editMany (entry " + i + ")", plan));
      const order = applyOrderShallowestFirst(plans);
      // Stage by stage across the WHOLE batch, not entry by entry. Within one entry `edit` already
      // orders producers before consumers; across entries only the batch can, and it must — an
      // entry that centers a hugging panel would otherwise read a width the entry editing that
      // panel's child is about to grow, and center it on the size it used to be.
      for (const i of order) applyEditPlanWrites(fails[i], plans[i], resources);
      for (const i of order) settleEditPlanSizes(fails[i], plans[i]);
      for (const i of order) settleEditPlanPositions(fails[i], plans[i]);
      // Handles are minted only once every write has landed: a hug parent reflows when a child in
      // the same batch changes, so geometry read mid-batch would be a number about to move.
      return plans.map((plan) => mintHandle(plan.node));
    },
  );
}
