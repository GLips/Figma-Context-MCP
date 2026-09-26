/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The write gate's decision, pure: given the Authorizing User, their cached seat, and how many Writes they
// have spent this month, may an execution START? It can't be known to mutate before it runs, so the
// gate refuses to start one once the allowance is spent and no seat covers the Authorizing User.
import { FREE_WRITE_ALLOWANCE, allowanceResetsAt } from "./write-ledger.js";

/**
 * A signed-in Authorizing User's seat as last validated. `seat`/`validatedAt` are null until the first
 * successful validation (sign-in finished during an outage).
 *
 * The seat outlives any failed request or outage by design (licensing/LICENSE-Framelink-Commercial.md
 * "Limit of the grant"): only a successful response saying `seat: false`, or a 401 dropping the
 * token, ends it.
 * There is deliberately no expiry on `validatedAt`.
 */
export interface CachedSeat {
  token: string;
  seat: boolean | null;
  validatedAt: string | null;
}

// How stale a validation may get before a connected server re-checks it.
export const SEAT_REVALIDATE_MS = 3 * 60 * 60 * 1000;

export type WriteAuthorization =
  | { kind: "authorized"; via: "seat"; figmaUserId: string }
  | { kind: "authorized"; via: "allowance"; figmaUserId: string; usedThisMonth: number }
  | { kind: "refused"; reason: "no-authorizingUser" }
  | {
      kind: "refused";
      reason: "allowance-exhausted";
      figmaUserId: string;
      usedThisMonth: number;
      resetsAt: Date;
      signedIn: boolean;
    };

export type WriteRefusal = Extract<WriteAuthorization, { kind: "refused" }>;

export function authorizeWriteExecution({
  figmaUserId,
  seat,
  usedThisMonth,
  now,
}: {
  figmaUserId: string | null;
  seat: CachedSeat | null;
  usedThisMonth: number;
  now: Date;
}): WriteAuthorization {
  if (figmaUserId === null) return { kind: "refused", reason: "no-authorizingUser" };
  if (seat?.seat === true) return { kind: "authorized", via: "seat", figmaUserId };
  if (usedThisMonth < FREE_WRITE_ALLOWANCE)
    return { kind: "authorized", via: "allowance", figmaUserId, usedThisMonth };
  return {
    kind: "refused",
    reason: "allowance-exhausted",
    figmaUserId,
    usedThisMonth,
    resetsAt: allowanceResetsAt(now),
    signedIn: seat !== null,
  };
}

export function isSeatRevalidationDue(seat: CachedSeat, now: Date): boolean {
  return (
    seat.validatedAt === null || now.getTime() - Date.parse(seat.validatedAt) >= SEAT_REVALIDATE_MS
  );
}

/**
 * What the Framelink panel in Figma shows about write access, pushed from the server. One shape for
 * both surfaces' facts: the refusal the agent reads and the card the human reads say the same thing.
 */
export type WriteAccessNotice =
  | { kind: "allowance-exhausted"; allowance: number; resetsAt: string; signedIn: boolean }
  | { kind: "sign-in-pending"; userCode: string; verificationUri: string }
  // `seat: null` — signed in, but the seat check that followed didn't get an answer yet.
  | { kind: "signed-in"; seat: boolean | null }
  | { kind: "sign-in-failed"; message: string };

export function allowanceExhaustedNotice(
  refusal: Extract<WriteRefusal, { reason: "allowance-exhausted" }>,
): WriteAccessNotice {
  return {
    kind: "allowance-exhausted",
    allowance: FREE_WRITE_ALLOWANCE,
    resetsAt: refusal.resetsAt.toISOString(),
    signedIn: refusal.signedIn,
  };
}

/** The tool result for a refused execution: nothing ran, why, and what the human does next. */
export function writeRefusalText(refusal: WriteRefusal, framelinkApiUrl: string): string {
  if (refusal.reason === "no-authorizingUser")
    return (
      "Framelink did not start this execution, so nothing ran: the Figma plugin did not report which " +
      "Figma user approved this session, and every write is attributed to that person. In the " +
      "Framelink plugin panel, click Revoke access on this session, make sure Figma is signed in, " +
      "then Allow it again and retry."
    );
  const resets = refusal.resetsAt.toISOString().slice(0, 10);
  const next = refusal.signedIn
    ? `The human is signed in to Framelink but has no seat. They can get one at ${framelinkApiUrl}, ` +
      `then retry this call — the server re-checks the seat on the next attempt.`
    : `Ask the human to click "Sign in to Framelink" in the Framelink plugin panel in Figma. It shows ` +
      `a code and opens ${framelinkApiUrl} in the browser, where they sign in with the Figma account ` +
      `they use in the plugin and get a seat. Then retry this call.`;
  return (
    `Framelink did not start this execution, so nothing ran on the canvas. The free allowance of ` +
    `${FREE_WRITE_ALLOWANCE} writes this month for the Figma user who approved this session is used up ` +
    `(it resets ${resets} UTC), and writes past it need a Framelink seat. ${next} ` +
    `get_screenshot and get_flcm_reference still work.`
  );
}
