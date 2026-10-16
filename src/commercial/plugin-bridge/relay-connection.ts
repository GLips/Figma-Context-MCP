/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { WebSocket } from "ws";
import type { PluginOwner } from "@framelink/plugin/protocol";
import { Logger } from "~/utils/logger.js";

/**
 * Where one plugin link stands. Every socket starts at `hello` (the version check), then either
 * stops at `incompatible` or is challenged (`authenticating`) and lands `unpaired` or
 * `authenticated` — or `credential-unusable`, when this server can't read or create the credential
 * to challenge with. Those two can be re-challenged, so they may return to `authenticating`.
 * Only an authenticated link is sent anything but the setup envelope, or heard on anything else.
 */
export type LinkStage =
  | { kind: "hello" }
  | { kind: "incompatible"; refusal: string }
  | { kind: "authenticating" }
  | { kind: "unpaired" }
  | { kind: "credential-unusable"; problem: string }
  | { kind: "authenticated"; owner: PluginOwner | null };

/** A stage still settling: a call that needs a plugin waits these out rather than guess. */
export function isSettlingLinkStage(stage: LinkStage): boolean {
  return stage.kind === "hello" || stage.kind === "authenticating";
}

/**
 * Everything the relay knows about ONE accepted socket — one plugin link — created on accept and
 * dropped as a unit, so a reconnecting plugin never inherits a predecessor's stage or owner.
 */
export class RelayConnection {
  private current: LinkStage = { kind: "hello" };
  private abandoned = false;
  private notifyStageChanged!: () => void;
  // Resolves on this link's next stage change, or when it is abandoned. A call waiting for the link
  // to settle is suspended on exactly this, so every path that drops the link must go through
  // `abandon()`, or that waiter is stranded.
  private changed: Promise<void> = this.nextChange();
  // Heartbeat liveness: each ping clears it, the pong sets it. Presumed alive at accept, so the first
  // tick pings rather than reaps.
  private alive = true;

  constructor(readonly socket: WebSocket) {}

  get isOpen(): boolean {
    return !this.abandoned && this.socket.readyState === WebSocket.OPEN;
  }

  get stage(): LinkStage {
    return this.current;
  }

  get isAuthenticated(): boolean {
    return this.current.kind === "authenticated";
  }

  /** Who this link is signed in as. Null until it authenticates, or when Figma names no user. */
  get owner(): PluginOwner | null {
    return this.current.kind === "authenticated" ? this.current.owner : null;
  }

  /** Settles on the next stage change or abandonment. */
  get stageChanged(): Promise<void> {
    return this.changed;
  }

  advance(stage: LinkStage): void {
    if (this.abandoned) return;
    this.current = stage;
    const notify = this.notifyStageChanged;
    this.changed = this.nextChange();
    notify();
  }

  /** This link will never be driven again: wake anything waiting on its stage. Idempotent. */
  abandon(): void {
    this.abandoned = true;
    this.notifyStageChanged();
  }

  send(frame: object): void {
    this.socket.send(JSON.stringify(frame));
  }

  /**
   * One heartbeat cycle: terminate a link that missed the previous ping's pong (half-open — dead
   * but no FIN, so `close` never fires and the link lingers), otherwise ping it.
   */
  heartbeat(): void {
    if (!this.isOpen) return;
    if (!this.alive) {
      Logger.log("Heartbeat: a plugin link missed a pong — terminating the half-open socket");
      this.socket.terminate();
      return;
    }
    this.alive = false;
    this.socket.ping();
  }

  pong(): void {
    this.alive = true;
  }

  private nextChange(): Promise<void> {
    return new Promise((resolve) => (this.notifyStageChanged = resolve));
  }
}
