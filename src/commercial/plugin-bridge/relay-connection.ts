/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { WebSocket } from "ws";
import { mintPairingCode } from "./approval.js";
import type { ProtocolCompatibility } from "./version.js";
import { Logger } from "~/utils/logger.js";

/**
 * Everything the relay knows about ONE accepted socket, created on accept and dropped as a unit. A
 * newer plugin taking the slot gets a fresh value, never its predecessor's verdict, pairing code or
 * proof of life — which is why none of these facts live on the bridge.
 */
export class RelayConnection {
  // Minted up front so the SESSION_INFO sent on connect (index.ts) and any pending-approval reply
  // share one source: the code in the panel matches the one in the tool result.
  readonly pairingCode = mintPairingCode();
  // Resolves when this connection's version verdict lands, or when the connection is abandoned with
  // the verdict still unknown. A canvas request holding for the verdict is suspended on exactly this
  // promise, so every path that drops the connection must go through `abandon()`, or that holder is
  // stranded with no timeout to save it (the request was never sent).
  readonly verdictSettled: Promise<void>;
  private settleVerdict!: () => void;
  private verdict: ProtocolCompatibility = "checking";
  private refusal: string | null = null;
  private abandoned = false;
  // True once the holder has answered the server over the frozen envelope: a real plugin (current,
  // or a stale one that envelope-ERRORs), not a dead or mute squatter. An established holder is never
  // displaced by a second connection (the anti-hijack rule); one that isn't is reclaimable.
  private established = false;
  // Heartbeat liveness: each ping clears it, the pong sets it. Presumed alive at accept, so the first
  // tick pings rather than reaps.
  private alive = true;

  constructor(readonly socket: WebSocket) {
    this.verdictSettled = new Promise((resolve) => {
      this.settleVerdict = resolve;
    });
  }

  get isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  /** `checking` until the version handshake answers — and forever, once abandoned. */
  get compatibility(): ProtocolCompatibility {
    return this.verdict;
  }

  /** The refusal text when this connection's verdict came back mismatched, else null. */
  get skewRefusal(): string | null {
    return this.verdict === "incompatible" ? this.refusal : null;
  }

  get isEstablished(): boolean {
    return this.established;
  }

  markEstablished(): void {
    this.established = true;
  }

  /** Record the handshake's verdict: null refusal means the plugin speaks this server's protocol. */
  decide(refusal: string | null): void {
    if (this.abandoned) return;
    this.refusal = refusal;
    this.verdict = refusal ? "incompatible" : "compatible";
    this.settleVerdict();
  }

  /** This connection will never be driven again: wake anything holding for its verdict. Idempotent. */
  abandon(): void {
    this.abandoned = true;
    this.verdict = "checking";
    this.settleVerdict();
  }

  send(frame: object): void {
    this.socket.send(JSON.stringify(frame));
  }

  /**
   * One heartbeat cycle: terminate a holder that missed the previous ping's pong (half-open — dead
   * but no FIN, so `close` never fires and the slot stays occupied), otherwise ping it.
   */
  heartbeat(): void {
    if (!this.isOpen) return;
    if (!this.alive) {
      Logger.log("Heartbeat: holder missed a pong — terminating the half-open socket");
      this.socket.terminate();
      return;
    }
    this.alive = false;
    this.socket.ping();
  }

  pong(): void {
    this.alive = true;
  }
}
