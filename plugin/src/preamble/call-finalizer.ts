/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// call-finalizer — the last phase of every mutating call: once every write has landed, the span
// has settled and the style links are linked, observe every obligation the call recorded. Any word
// the canvas doesn't hold as asked fails the call inside the lock's rollback, so a call either
// realizes every authored word or applies nothing.

import { concessionsOnNode, describeObligationTarget, obligationsInCall, resolveObligationTarget, type Obligation } from "./obligation.js";
import { describeObligationRequest, observeObligation, type PendingStyleLink } from "./obligation-observers.js";
import { describeInstanceWriteRule } from "./instance-write-policy.js";
import { contradictingObligation } from "./call-obligations.js";

declare const VERIFIED_CALL: unique symbol;
/**
 * The call's queued style links, once every obligation has been verified: the lock's point of no
 * return. Only the finalizer mints it and only linking takes it, so nothing that can fail the call
 * for what it wrote can be placed after the await the links need.
 */
export type VerifiedStyleLinks = readonly PendingStyleLink[] & { readonly [VERIFIED_CALL]: true };

/** A call whose writes landed but left authored words unrealized; the lock rolls it back. */
export class UnrealizedWordsError extends Error {}

const LISTED_WORDS = 20;

/**
 * Runs before the style-link await, with the links still queued, so a call that fails rolls back
 * with no await between its first write and the undo: an edit made in Figma during an await joins
 * the call's undo step, and the rollback then reverts nothing.
 */
export function finalizeMutatingCall(verb: string, pendingLinks: readonly PendingStyleLink[]): VerifiedStyleLinks {
  const subject = "flcm." + verb;
  const lines: string[] = [];
  let unrealized = 0;
  const all = obligationsInCall();
  for (const obligation of all) {
    const seen = observeObligation(obligation, pendingLinks);
    if (seen.realized) continue;
    unrealized++;
    if (lines.length === LISTED_WORDS) continue;
    // The call site minus the verb: "[2]" for an editMany entry, nothing for a lone edit.
    const site = obligation.source.subject.startsWith(subject) ? obligation.source.subject.slice(subject.length) : obligation.source.subject;
    lines.push(
      "  " + (site ? site + " " : "") + describeObligationTarget(obligation.target) + " " + obligation.source.path +
        ": asked " + describeObligationRequest(obligation) + ", ended " + seen.ended + whyOf(obligation, all, subject) + ".",
    );
  }
  if (unrealized === 0) return pendingLinks as VerifiedStyleLinks;
  if (unrealized > LISTED_WORDS) lines.push("  and " + (unrealized - LISTED_WORDS) + " more.");
  throw new UnrealizedWordsError(
    subject + ": this call didn't realize " + unrealized + " of its words, so it rolled back and nothing was applied.\n" + lines.join("\n"),
  );
}

// Only what the ledger knows for certain; a word with no known cause names none.
function whyOf(obligation: Obligation, all: readonly Obligation[], subject: string): string {
  const other = contradictingObligation(obligation, all);
  if (other) {
    const site = other.source.subject.startsWith(subject) ? other.source.subject.slice(subject.length) : other.source.subject;
    return " — " + (site ? site + " " : "") + other.source.path + " asks " + describeObligationRequest(other) + " of the same layer; state it once";
  }
  if (typeof obligation.writability === "object") return " — the call can't write it here, so it had to hold already: " + describeInstanceWriteRule(obligation.writability.realizeOnly);
  if (obligation.kind === "axisSize") {
    const dimension = (obligation as Obligation<"axisSize">).request.axis === "horizontal" ? "width" : "height";
    const node = resolveObligationTarget(obligation.target);
    const miss = node ? concessionsOnNode(node).find((c) => c.kind === "write-time-resize-miss" && c.axis === dimension) : undefined;
    if (miss) return " — Figma sized it to " + miss.realized + " when this call wrote it, and a later write in this call changed that";
  }
  if (obligation.writtenAt === undefined && obligation.heldAtWritePoint) return " — it held when this call reached it, and a later write in this call changed it";
  return "";
}
