/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// One owner for a Write's settlement lifecycle. The invariant it holds: every allowance-authorized
// execution is reserved while its caller waits, then recorded or released the moment that caller ends
// it. The plugin's reply is final, so nothing is settled after the caller is done.
//
// Everything is keyed by the execution id the caller minted, which is also the run's id on the wire.
// Callers see only an ExecutionCharge. Seats get a charge that does nothing — they carry no counters.
import type { PluginOwner, WriteAccessNotice } from "@framelink/plugin/protocol";
import type { ExecutionId } from "~/commercial/execution-id.js";
import type { WriteAccess } from "./write-access.js";
import {
  allowanceExhaustedNotice,
  type WriteAuthorization,
  type WriteRefusal,
} from "./write-authorization.js";

/** The plugin link a run goes out on, as the meter sees it: charged to its owner. */
export interface MeteredLink {
  readonly owner: PluginOwner | null;
}

/**
 * What became of one authorized execution, reported by the caller that runs it. End it with replied
 * or lost on every path — an unended allowance charge holds its reservation for good. Only the first
 * end counts.
 */
export interface ExecutionCharge {
  /** The plugin answered: a Write if the document changed. */
  replied(documentChanged: boolean): void;
  /**
   * No answer. `mayHaveRun`: the run may have touched the document, so it is charged now. A reply
   * that arrives after this changes nothing: waiting for it would hold the caller open.
   */
  lost(outcome: { mayHaveRun: boolean }): void;
}

export type ExecutionAdmission =
  | {
      kind: "authorized";
      authorization: Extract<WriteAuthorization, { kind: "authorized" }>;
      charge: ExecutionCharge;
    }
  | { kind: "refused"; refusal: WriteRefusal };

const SEAT_CHARGE: ExecutionCharge = { replied() {}, lost() {} };

export class WriteMeter {
  // The owner of each allowance execution whose caller still waits on it: a reservation, counted as
  // spent so parallel calls can't all pass the gate on the same last Write.
  private readonly inFlight = new Map<ExecutionId, string>();
  private readonly notifyOwnerPanels: (figmaUserId: string, notice: WriteAccessNotice) => void;

  constructor(
    private readonly access: WriteAccess,
    {
      notifyOwnerPanels = () => {},
    }: {
      /** Show a notice in the panels of the plugin owner it concerns, and no one else's. */
      notifyOwnerPanels?: (figmaUserId: string, notice: WriteAccessNotice) => void;
    } = {},
  ) {
    this.notifyOwnerPanels = notifyOwnerPanels;
  }

  get framelinkApiUrl(): string {
    return this.access.framelinkApiUrl;
  }

  /**
   * May an execution through `link` start? It is attributed to the link's owner. An allowance
   * authorization reserves a Write until its charge ends. Allowance refusals also go to that owner's
   * panels.
   */
  async authorize(link: MeteredLink, executionId: ExecutionId): Promise<ExecutionAdmission> {
    let decision = this.decide(link.owner);
    if (
      decision.kind === "refused" &&
      decision.reason === "allowance-exhausted" &&
      decision.signedIn
    ) {
      await this.access.recheckRefusedSeat(decision.figmaUserId);
      decision = this.decide(link.owner);
    }
    // Synchronous with the decision above, so no other call can decide in between.
    if (decision.kind === "refused") {
      if (decision.reason === "allowance-exhausted")
        this.notifyOwnerPanels(decision.figmaUserId, allowanceExhaustedNotice(decision));
      return { kind: "refused", refusal: decision };
    }
    if (decision.via === "seat")
      return { kind: "authorized", authorization: decision, charge: SEAT_CHARGE };
    this.inFlight.set(executionId, decision.figmaUserId);
    return {
      kind: "authorized",
      authorization: decision,
      charge: {
        replied: (documentChanged) => this.settle(executionId, documentChanged),
        lost: ({ mayHaveRun }) => this.settle(executionId, mayHaveRun),
      },
    };
  }

  private decide(owner: PluginOwner | null): WriteAuthorization {
    const figmaUserId = owner?.figmaUserId;
    let reserved = 0;
    for (const reservedBy of this.inFlight.values()) if (reservedBy === figmaUserId) reserved++;
    return this.access.decide(owner, reserved);
  }

  private settle(executionId: ExecutionId, wrote: boolean): void {
    const figmaUserId = this.inFlight.get(executionId);
    if (figmaUserId === undefined) return;
    this.inFlight.delete(executionId);
    if (wrote) this.access.recordWrite(figmaUserId, executionId);
  }
}
