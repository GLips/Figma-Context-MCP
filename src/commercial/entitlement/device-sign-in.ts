/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The Framelink device sign-in (RFC 8628) for a Plugin Owner: request a code, show it in that owner's
// plugin panels, poll until the human finishes in the browser, then hand the token to WriteAccess,
// which decides whether to keep it. One flow per Plugin Owner; a second click re-shows its code.
import { setTimeout as pause } from "node:timers/promises";
import type { PluginOwner, WriteAccessNotice } from "@framelink/plugin/protocol";
import { Logger } from "~/utils/logger.js";
import { FramelinkApiError, type FramelinkApiClient } from "./framelink-api.js";
import type { WriteAccess } from "./write-access.js";

// RFC 8628 §3.5: each slow_down adds five seconds to the polling interval.
const SLOW_DOWN_STEP_MS = 5_000;

type SignInFlow = { notice: WriteAccessNotice | null; done: Promise<void> };

/** What a panel whose plugin reports no Figma user is told when its sign-in button is clicked. */
export const SIGN_IN_NEEDS_FIGMA_USER_NOTICE: WriteAccessNotice = {
  kind: "sign-in-failed",
  message:
    "Figma didn't report a signed-in user to the plugin. Sign in to Figma, reopen the Framelink plugin, then sign in here.",
};

export class DeviceSignIn {
  // Keyed by figmaUserId.
  private readonly flows = new Map<string, SignInFlow>();
  private readonly lifetime = new AbortController();
  private readonly now: () => Date;

  constructor(
    private readonly api: FramelinkApiClient,
    private readonly access: WriteAccess,
    /** Show a notice in the panels of the plugin owner signing in, and no one else's. */
    private readonly notifyOwnerPanels: (figmaUserId: string, notice: WriteAccessNotice) => void,
    { now = () => new Date() }: { now?: () => Date } = {},
  ) {
    this.now = now;
  }

  /** Stop polling when a short-lived runtime exits. */
  stop(): void {
    this.lifetime.abort();
  }

  /**
   * Start (or re-show) the sign-in for this Plugin Owner. Their panels get the code and
   * verification URL, then the outcome. Resolves when the flow ends, for callers that wait.
   */
  start(owner: PluginOwner): Promise<void> {
    const { figmaUserId } = owner;
    const live = this.flows.get(figmaUserId);
    if (live) {
      if (live.notice) this.notifyOwnerPanels(figmaUserId, live.notice);
      return live.done;
    }
    const flow: SignInFlow = { notice: null, done: Promise.resolve() };
    flow.done = this.run(figmaUserId, (notice) => {
      flow.notice = notice;
      this.notifyOwnerPanels(figmaUserId, notice);
    }).finally(() => this.flows.delete(figmaUserId));
    this.flows.set(figmaUserId, flow);
    return flow.done;
  }

  private async run(
    figmaUserId: string,
    notify: (notice: WriteAccessNotice) => void,
  ): Promise<void> {
    let signIn;
    try {
      signIn = await this.api.requestDeviceSignIn(figmaUserId);
    } catch (err) {
      if (!(err instanceof FramelinkApiError)) throw err;
      notify({
        kind: "sign-in-failed",
        message:
          err.kind === "rejected"
            ? "Framelink turned down the sign-in request. Make sure Framelink MCP is up to date, then try again."
            : "Couldn't reach Framelink. Try again shortly.",
      });
      return;
    }
    if (this.lifetime.signal.aborted) return;
    notify({
      kind: "sign-in-pending",
      userCode: signIn.userCode,
      verificationUri: signIn.verificationUri,
    });
    const deadline = this.now().getTime() + signIn.expiresInMs;
    let intervalMs = signIn.intervalMs;
    while (this.now().getTime() < deadline) {
      try {
        await pause(intervalMs, undefined, { signal: this.lifetime.signal });
      } catch {
        return;
      }
      let poll;
      try {
        poll = await this.api.pollDeviceToken(signIn.deviceCode);
      } catch (err) {
        if (!(err instanceof FramelinkApiError)) throw err;
        // A dropped poll is not an answer; the code is still good until it expires.
        if (err.kind === "unavailable") continue;
        poll = { kind: "failed", error: err.message } as const;
      }
      if (this.lifetime.signal.aborted) return;
      if (poll.kind === "pending") continue;
      if (poll.kind === "slow-down") {
        intervalMs += SLOW_DOWN_STEP_MS;
        continue;
      }
      if (poll.kind === "denied") {
        notify({ kind: "sign-in-failed", message: "The sign-in was declined." });
        return;
      }
      if (poll.kind === "expired") break;
      if (poll.kind === "failed") {
        Logger.log(`Device sign-in failed: ${poll.error}`);
        notify({ kind: "sign-in-failed", message: "The sign-in didn't go through. Start again." });
        return;
      }
      const seat = await this.access.adoptSignInToken(figmaUserId, poll.accessToken);
      if (!seat) {
        notify({
          kind: "sign-in-failed",
          message: "Framelink didn't accept that sign-in for this Figma user. Try again.",
        });
        return;
      }
      notify({ kind: "signed-in", seat: seat.seat });
      return;
    }
    notify({ kind: "sign-in-failed", message: "The sign-in code expired. Start again." });
  }
}
