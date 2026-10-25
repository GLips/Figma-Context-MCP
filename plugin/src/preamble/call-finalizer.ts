/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// call-finalizer — the last phase of every mutating call: once every write has landed, the span
// has settled and the style links are linked, observe every obligation the call recorded. Any word
// the canvas doesn't hold as asked fails the call inside the lock's rollback, so a call either
// realizes every authored word or applies nothing. The message speaks of "values", never "words":
// the agent wrote a spec, not the obligation ledger.

import { concessionsOnNode, describeObligationTarget, obligationsInCall, resolveObligationTarget, type Obligation } from "./obligation.js";
import { describeObligationRequest, observeObligation, type PendingStyleLink } from "./obligation-observers.js";
import { describeInstanceWriteRule } from "./instance-write-policy.js";
import { contradictingObligation } from "./call-obligations.js";
import { FlcmError } from "./flcm-error.js";
import type { FlcmErrorKind } from "../protocol.js";

declare const VERIFIED_CALL: unique symbol;
/**
 * The call's queued style links, once every obligation has been verified: the lock's point of no
 * return. Only the finalizer mints it and only linking takes it, so nothing that can fail the call
 * for what it wrote can be placed after the await the links need.
 */
export type VerifiedStyleLinks = readonly PendingStyleLink[] & { readonly [VERIFIED_CALL]: true };

const LISTED_WORDS = 20;

/**
 * Runs before the style-link await, with the links still queued, so a call that fails rolls back
 * with no await between its first write and the undo: an edit made in Figma during an await joins
 * the call's undo step, and the rollback then reverts nothing.
 */
export function finalizeMutatingCall(verb: string, pendingLinks: readonly PendingStyleLink[]): VerifiedStyleLinks {
  const subject = "flcm." + verb;
  const unmet: { line: string; kind: FlcmErrorKind }[] = [];
  let unrealized = 0;
  let kind: FlcmErrorKind = "internal";
  const all = obligationsInCall();
  for (const obligation of all) {
    const seen = observeObligation(obligation, pendingLinks);
    if (seen.realized) continue;
    unrealized++;
    const why = whyOf(obligation, all, subject);
    kind = blameOf(kind, why.kind);
    if (unmet.length === LISTED_WORDS) continue;
    // The call site minus the verb: "[2]" for an editMany entry, nothing for a lone edit.
    const site = obligation.source.subject.startsWith(subject) ? obligation.source.subject.slice(subject.length) : obligation.source.subject;
    unmet.push({
      line: "  " + (site ? site + " " : "") + describeObligationTarget(obligation.target) + " " + obligation.source.path +
        ": asked " + describeObligationRequest(obligation) + ", ended " + seen.ended + why.text,
      kind: why.kind,
    });
  }
  if (unrealized === 0) return pendingLinks as VerifiedStyleLinks;
  // The bug advice is the error's own when the whole call is flcm's; beside the agent's lines it is said per line.
  const lines = unmet.map(({ line, kind: own }) => line + (own === "internal" && kind !== "internal" ? " (a bug in flcm, not in your script)" : "") + ".");
  if (unrealized > LISTED_WORDS) lines.push("  and " + (unrealized - LISTED_WORDS) + " more.");
  const values = unrealized === 1 ? "1 value it set" : unrealized + " values it set";
  throw new FlcmError(
    kind,
    "this call didn't come out as written: " + values + " ended differently than asked." + (NEXT_STEP[kind] ? " " + NEXT_STEP[kind] : "") + "\n" + lines.join("\n"),
  );
}

// The kind is the whole call's (blameOf), so the step is too. A bug's advice is the error's own.
const NEXT_STEP: Partial<Record<FlcmErrorKind, string>> = {
  authoring: "Fix the values below, then re-run the call.",
  figma: "Figma can't set the values below here: change or drop them, then re-run the call.",
};

// One kind for the whole call, the most actionable: the agent's own mistake outranks a Figma limit,
// and the call reads as flcm's bug only when every unmet value is one.
const BLAME_RANK: Partial<Record<FlcmErrorKind, number>> = { internal: 0, figma: 1, authoring: 2 };
function blameOf(so: FlcmErrorKind, word: FlcmErrorKind): FlcmErrorKind {
  return (BLAME_RANK[word] ?? 0) > (BLAME_RANK[so] ?? 0) ? word : so;
}

// Only what the ledger knows for certain; a word with no known cause names none, and is flcm's: the
// call was legal, the words don't contradict, and flcm still didn't land it. A word that held when
// the call reached it and that a later write undid is the same — ordering writes is flcm's job.
function whyOf(obligation: Obligation, all: readonly Obligation[], subject: string): { kind: FlcmErrorKind; text: string } {
  const other = contradictingObligation(obligation, all);
  if (other) {
    const site = other.source.subject.startsWith(subject) ? other.source.subject.slice(subject.length) : other.source.subject;
    return { kind: "authoring", text: " — " + (site ? site + " " : "") + other.source.path + " asks " + describeObligationRequest(other) + " of the same layer; state it once" };
  }
  if (typeof obligation.writability === "object") return { kind: "figma", text: " — the call can't write it here, so it had to hold already: " + describeInstanceWriteRule(obligation.writability.realizeOnly) };
  if (obligation.kind === "axisSize") {
    const dimension = (obligation as Obligation<"axisSize">).request.axis === "horizontal" ? "width" : "height";
    const node = resolveObligationTarget(obligation.target);
    const miss = node ? concessionsOnNode(node).find((c) => c.kind === "write-time-resize-miss" && c.axis === dimension) : undefined;
    if (miss) return { kind: "figma", text: " — Figma sized it to " + miss.realized + " when this call wrote it, and a later write in this call changed that" };
  }
  if (obligation.writtenAt === undefined && obligation.heldAtWritePoint) return { kind: "internal", text: " — it held when this call reached it, and a later write in this call changed it" };
  return { kind: "internal", text: "" };
}
