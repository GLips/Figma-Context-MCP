/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// call-obligations — what a verb's gate checks of the call's words before the first write, so a
// call the finalizer would only roll back is refused with zero writes instead. Two checks:
//
// Drift. A word the node already held when prepare read it, and that changed while the call was
// loading, is a value someone else just wrote: writing the call's copy would undo it. Refused.
//
// Realize-only words. A word the instance write policy forbids writing must already hold. One that
// doesn't, and that no write in the call can produce — a geometry write that reaches it
// (geometry-dependency.ts), or an edit of a main component it inherits from — is refused naming the
// rule. Advisory: the finalizer decides every word again once the call has landed.

import { stableStringify } from "@framelink/core";
import { describeNodeIdentity, type InstanceContextFacts } from "./identity.js";
import { instanceWriteRefusal } from "./instance-write-authorization.js";
import type { InstanceWriteRuleId } from "./instance-write-policy.js";
import { concessionsOnNode, resolveObligationTarget, type Obligation, type ObligationKind } from "./obligation.js";
import { OBLIGATION_OBSERVERS, observeObligation, type ObligationObserver } from "./obligation-observers.js";
import { geometryProducedBy, type GeometryEffect, type GeometryProjection } from "./geometry-dependency.js";
import { definitionsInheritedBy, type InstanceMains } from "./operation-schedule.js";

/** A realize-only word, observed against its basis: the live node, or the definition sublayer a projected plan compiled on. */
export interface RealizeOnlyCheck {
  readonly obligation: Obligation;
  readonly rule: InstanceWriteRuleId;
  /** The word as a refusal names it ("height (a fixed size where the layer hugs)"). */
  readonly word: string;
  readonly who: string;
  readonly context: InstanceContextFacts;
}

interface CapturedReading { readonly reading: unknown; readonly realized: boolean }

/** What prepare read of each word before its loads, keyed by the node and the authored word. */
export interface ReadDependencies { readonly readings: ReadonlyMap<string, CapturedReading> }

export const NO_READ_DEPENDENCIES: ReadDependencies = { readings: new Map() };

const observerOf = (kind: ObligationKind) => OBLIGATION_OBSERVERS[kind] as unknown as ObligationObserver<ObligationKind, unknown>;

// One key per obligation: two of one word on one node (a constraint's axes) are told apart by order.
function keyed(obligations: readonly Obligation[]): { key: string; obligation: Obligation; node: SceneNode }[] {
  const seen = new Map<string, number>();
  return obligations.flatMap((obligation) => {
    const node = resolveObligationTarget(obligation.target);
    if (!node) return [];
    const base = [node.id, obligation.source.subject, obligation.source.path, obligation.kind].join("|");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return [{ key: base + "|" + n, obligation, node }];
  });
}

/** Read each obligation's word now. Prepare calls it immediately before its font and image loads. */
export function captureReadDependencies(obligations: readonly Obligation[]): ReadDependencies {
  const readings = new Map<string, CapturedReading>();
  for (const { key, obligation, node } of keyed(obligations)) {
    const observer = observerOf(obligation.kind);
    const reading = observer.read(node, obligation.request);
    readings.set(key, { reading, realized: observer.realizes(reading, obligation.request, concessionsOnNode(node)) });
  }
  return { readings };
}

export interface CallObligations {
  /** The call's obligations, as the gate derived them. */
  readonly obligations?: readonly Obligation[];
  readonly dependencies?: ReadDependencies;
  readonly checks?: readonly RealizeOnlyCheck[];
  /** Every geometry write the call makes, for what a realize-only word can wait on. */
  readonly writes?: readonly GeometryEffect[];
  /** The call's own layout words, by node id, which decide what those writes reach. */
  readonly projection?: GeometryProjection;
  /** The components whose definition the call edits, by id, and the mains prepare resolved: what an instance word can inherit. */
  readonly defines?: ReadonlySet<string>;
  readonly mains?: InstanceMains;
}

/** Refuse the call before any write when a word drifted under it, or a realize-only word can't come to hold. */
export function gateCallObligations(call: CallObligations, subject: string): void {
  assertNoDrift(call.obligations ?? [], call.dependencies ?? NO_READ_DEPENDENCIES, subject);
  assertRealizeOnlyWordsCanHold(call.checks ?? [], (obligation) => producedLater(obligation, call), subject);
}

/** A word someone else changed while the call loaded: no fix to the call's words answers it, only a fresh read. */
export class ReadDriftError extends Error {}

function assertNoDrift(obligations: readonly Obligation[], dependencies: ReadDependencies, subject: string): void {
  if (!dependencies.readings.size) return;
  for (const { key, obligation, node } of keyed(obligations)) {
    const before = dependencies.readings.get(key);
    if (!before?.realized) continue;
    const observer = observerOf(obligation.kind);
    const now = observer.read(node, obligation.request);
    if (stableStringify(now) === stableStringify(before.reading) || observer.realizes(now, obligation.request, concessionsOnNode(node))) continue;
    // It held at prepare, so what it was is the request itself: a holding reading may carry no description.
    const asked = observer.describeRequest(obligation.request);
    throw new ReadDriftError(
      subject + ": " + describeNodeIdentity(node) + " " + obligation.source.path + " changed while this call was loading fonts and images (it was " +
        asked + ", now " + observer.describeReading(now) + "), and this call restated " + asked +
        " — writing it would undo that change. Nothing was applied: read the node again and re-run.",
    );
  }
}

function assertRealizeOnlyWordsCanHold(checks: readonly RealizeOnlyCheck[], producible: (obligation: Obligation) => boolean, subject: string): void {
  const refused = new Map<string, { check: RealizeOnlyCheck; byRule: Map<InstanceWriteRuleId, Set<string>> }>();
  for (const check of checks) {
    if (observeObligation(check.obligation).realized || producible(check.obligation)) continue;
    const entry = refused.get(check.who) ?? { check, byRule: new Map() };
    refused.set(check.who, entry);
    entry.byRule.set(check.rule, (entry.byRule.get(check.rule) ?? new Set()).add(check.word));
  }
  const [first] = [...refused.values()];
  if (!first) return;
  throw instanceWriteRefusal(subject, first.check.who, first.check.context, [...first.byRule].map(([rule, words]) => ({ rule, words: [...words] })));
}

// Whether a write elsewhere in the call can still bring the word to hold: one whose geometry
// reaches it, or one on a definition its layer inherits from (which the schedule lands first).
function producedLater(obligation: Obligation, call: CallObligations): boolean {
  const node = resolveObligationTarget(obligation.target);
  if (!node) return false;
  if (call.writes?.length && geometryProducedBy(obligation, node, call.writes, call.projection)) return true;
  if (!call.defines?.size || !call.mains) return false;
  for (const id of definitionsInheritedBy(node.id, node.type === "INSTANCE", call.mains)) if (call.defines.has(id)) return true;
  return false;
}

// ---- one layer's word stated twice, differently ----

// Words whose requests cover a range of a text, where two different ones can both hold.
const RANGED_KINDS: ReadonlySet<ObligationKind> = new Set(["textRuns", "fontIdentity", "textMetric", "textDecoration", "textCase", "hyperlink"]);
// What tells two words of one kind apart on one layer: a size's axis, a paint's slot, a bound.
const FACET_KEYS = ["axis", "slot", "bound", "field", "wire", "name", "declare", "delete"] as const;
// The agent's spellings, which a request keeps only for its messages: "#f00" and "#ff0000" are one paint.
const SPELLING_KEYS: ReadonlySet<string> = new Set(["spelled", "styleName", "componentName", "written"]);

function facetOf(obligation: Obligation): string | null {
  if (RANGED_KINDS.has(obligation.kind)) return null;
  const request = obligation.request as unknown;
  if (request === null || typeof request !== "object") return obligation.kind;
  if ((request as { except?: readonly unknown[] }).except?.length) return null;
  return [obligation.kind, ...FACET_KEYS.map((key) => stableStringify((request as Record<string, unknown>)[key] ?? null))].join("|");
}

function withoutSpelling(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSpelling);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SPELLING_KEYS.has(key) || (key === "variable" && "variableId" in value)) continue;
    out[key] = withoutSpelling(entry);
  }
  return out;
}

/** Another call site's word on the same layer and field that asks something else, if any. */
export function contradictingObligation(obligation: Obligation, among: readonly Obligation[]): Obligation | undefined {
  const facet = facetOf(obligation);
  const node = facet === null ? null : resolveObligationTarget(obligation.target);
  if (!node) return undefined;
  const asked = stableStringify(withoutSpelling(obligation.request));
  return among.find((other) => other.source.subject !== obligation.source.subject && facetOf(other) === facet &&
    resolveObligationTarget(other.target) === node && stableStringify(withoutSpelling(other.request)) !== asked);
}

/**
 * Refuse a call two of whose sites state one layer's word differently (an instance's override and
 * the same sublayer by its own id): both can't hold, so the call would only roll back.
 */
export function assertNoContradictoryWords(obligations: readonly Obligation[], subject: string): void {
  const site = (obligation: Obligation) => (obligation.source.subject.startsWith(subject) ? obligation.source.subject.slice(subject.length) : obligation.source.subject);
  for (const obligation of obligations) {
    const other = contradictingObligation(obligation, obligations);
    if (!other) continue;
    const node = resolveObligationTarget(obligation.target)!;
    throw new Error(
      subject + ": " + site(obligation) + " " + obligation.source.path + " and " + site(other) + " " + other.source.path + " both state " +
        describeNodeIdentity(node) + "'s " + other.source.path.split(".").pop() + " (" + observerOf(obligation.kind).describeRequest(obligation.request) + " vs " +
        observerOf(other.kind).describeRequest(other.request) + "); state it once. Nothing was applied.",
    );
  }
}
