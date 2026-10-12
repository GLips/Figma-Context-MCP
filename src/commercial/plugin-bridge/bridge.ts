/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { WebSocket } from "ws";
import { Logger } from "~/utils/logger.js";
import { ApprovalStore } from "./approval-store.js";
import { ApprovalSession, type ApprovedSession } from "./approval-session.js";
import { pluginDisconnectedNotSubmittedText } from "./blocked-call-guidance.js";
import { ChannelServer, type CapabilityHandler } from "./channel-server.js";
import { RelayConnection } from "./relay-connection.js";
import { MAX_CHANNEL_BYTES, RECLAIM_WINDOW_MS, RelayListener } from "./relay-listener.js";
import { RequestTrace } from "./request-trace.js";
import {
  BridgeRequestError,
  DEFAULT_RUN_CEILING_MS,
  DEFAULT_TIMEOUT_MS,
  NO_RUN_CONTEXT,
  RunLedger,
  type ChannelRunContext,
} from "./run-ledger.js";
import { refuseProtocolSkew, type ProtocolCompatibility } from "./version.js";
import type { RunEvent } from "../entitlement/write-meter.js";
import {
  HANDSHAKE_REQUEST_TYPES,
  PROTOCOL_VERSION,
  parseExecuteCodeResult,
  parsePluginEvent,
  type PendingApprovalReply,
  type PluginEvent,
  type PluginEventType,
  type PluginReply,
  type ReplyFor,
  type ServerRequest,
  type ServerRequestType,
} from "@framelink/plugin/protocol";

export { BridgeRequestError, type ChannelRunContext, type RequestPhase } from "./run-ledger.js";
export type { CapabilityHandler } from "./channel-server.js";

/**
 * Unsolicited plugin events the bridge relays but doesn't own. All arrive only from the current
 * holder, and the first two only once its version handshake passes. `onSessionApproved` fires on each
 * Allow handover — the moment write access is checked.
 */
export interface PluginBridgeEvents {
  onSessionApproved?: (session: ApprovedSession) => void;
  /** The human clicked the panel's sign-in button. */
  onWriteAccessSignIn?: () => void;
  /**
   * What the current holder says about a run outside its caller's reply: RUN_CHANGED, RUN_SETTLED,
   * or a result that arrived after the caller gave up. Forwarded as-is — what it costs is the
   * write meter's call. May fire more than once for a run, and for run ids this server never issued.
   */
  onRunEvent?: (event: RunEvent) => void;
}

/** The plugin's answer to an approval poll, with the session a GRANTED admits read at that instant. */
export type ApprovalStatus =
  | { type: "APPROVAL_GRANTED"; session: ApprovedSession | null }
  | PendingApprovalReply
  | { type: "APPROVAL_REJECTED" };

// The only requests exempt from the compatibility hold in `request()`; see the protocol's list.
const HANDSHAKE_REQUESTS = new Set<ServerRequestType>(HANDSHAKE_REQUEST_TYPES);

/**
 * Who may send a plugin event. `any` connection — diagnostics only, never settling anything; the
 * current `holder`; or a holder whose version handshake passed (`compatible-holder`), for anything
 * that changes durable approval state or starts network work. `verifyClient` admits any Origin-less
 * or `null`-origin client into a free slot, so "is the current socket" alone would let a page or local
 * process plant or wipe the persisted approval. Any peer that echoes GET_VERSION passes, so this raises
 * the bar rather than authenticating; the plugin's approved-token check stays the real gate.
 */
type Acceptance = "any" | "holder" | "compatible-holder";
type EventRoute<K extends PluginEventType> = {
  from: Acceptance;
  handle: (connection: RelayConnection, event: Extract<PluginEvent, { type: K }>) => void;
};
type EventRoutes = { [K in PluginEventType]: EventRoute<K> };

/**
 * The relay to the Figma plugin: one connection slot, and the composition of its parts — the
 * listener (network edge), the run ledger (requests and their clocks), the channel server (the
 * reverse direction) and the approval session (what this server presents and persists).
 *
 * The slot is the one place holder identity lives: a frame is honored per its event's Acceptance,
 * and a socket that no longer holds the slot is ignored. Every connection runs its own GET_VERSION
 * handshake, and a request that isn't part of it is held until the verdict lands, then sent or refused.
 */
export class PluginBridge {
  private current: RelayConnection | null = null;
  private disconnectedAt: number | null = null;
  private onConnect: (() => void) | undefined;
  private readonly listener: RelayListener;
  private readonly ledger: RunLedger;
  private readonly channel: ChannelServer;
  private readonly approval: ApprovalSession;
  private readonly events: PluginBridgeEvents;

  private readonly routes: EventRoutes = {
    // Diagnostic traffic is observed even from a displaced request owner. It never participates in
    // settlement or inactivity rearming, and the trace retains no response contents.
    RUN_TRACE: {
      from: "any",
      handle: (connection, event) => this.ledger.trace.recordHost(event.runId, connection, event),
    },
    SESSION_TOKEN: {
      from: "compatible-holder",
      handle: (_, event) =>
        this.approval.apply({
          type: "handedOver",
          session: { token: event.sessionToken, authorizingUser: event.authorizingUser },
        }),
    },
    SESSION_CLAIM: {
      from: "compatible-holder",
      handle: (_, event) => this.approval.apply({ type: "claimed", claim: event.sessionClaim }),
    },
    REVOKE_SESSION: {
      from: "compatible-holder",
      handle: () => this.approval.apply({ type: "revoked" }),
    },
    WRITE_ACCESS_SIGN_IN: {
      from: "compatible-holder",
      handle: () => this.events.onWriteAccessSignIn?.(),
    },
    CHANNEL_REQUEST: {
      from: "holder",
      handle: (connection, event) => {
        // A reverse request proves the holder speaks the envelope, exactly like a matched reply.
        connection.markEstablished();
        this.channel.serve(connection, event);
      },
    },
    RUN_STATE: {
      from: "holder",
      handle: (connection, event) => this.ledger.runState(connection, event),
    },
    // Run-scoped, so it settles here rather than through the correlated-reply path.
    CANCEL_RESULT: {
      from: "holder",
      handle: (connection, event) =>
        this.ledger.settleCancelAnswer(event.runId, event.disposition, connection),
    },
    // Metering outlives the caller, so these go to the meter, never to the run's caller.
    RUN_CHANGED: {
      from: "holder",
      handle: (_, event) => this.events.onRunEvent?.({ type: "changed", runId: event.runId }),
    },
    RUN_SETTLED: {
      from: "holder",
      handle: (_, event) => this.events.onRunEvent?.({ type: "settled", runId: event.runId }),
    },
  };

  // Everything injectable for the tests and the contract harness: `store` isolates persistence to a
  // temp dir; the clocks let them pin timeout behaviour without waiting out the real deadlines; `trace`
  // lets a test read what the trace kept. Production takes the defaults, and index.ts registers the
  // production capability allowlist.
  constructor(
    store: ApprovalStore = new ApprovalStore(),
    {
      requestTimeoutMs = DEFAULT_TIMEOUT_MS,
      runCeilingMs = DEFAULT_RUN_CEILING_MS,
      reclaimWindowMs = RECLAIM_WINDOW_MS,
      capabilities = new Map(),
      events = {},
      trace = new RequestTrace((event) => Logger.log("Bridge trace " + JSON.stringify(event))),
    }: {
      requestTimeoutMs?: number;
      runCeilingMs?: number;
      reclaimWindowMs?: number;
      capabilities?: ReadonlyMap<string, CapabilityHandler>;
      events?: PluginBridgeEvents;
      trace?: RequestTrace;
    } = {},
  ) {
    this.events = events;
    this.approval = new ApprovalSession(store, (session) =>
      this.events.onSessionApproved?.(session),
    );
    this.ledger = new RunLedger({
      requestTimeoutMs,
      runCeilingMs,
      trace,
      disconnectedDurationMs: () => this.disconnectedDurationMs(),
    });
    this.channel = new ChannelServer(
      capabilities,
      this.ledger,
      (connection) => connection === this.current,
    );
    this.listener = new RelayListener(
      {
        // Anti-hijack, liveness-aware: an ESTABLISHED holder is never displaced, so a page or local
        // process can't steal a live plugin's channel by connecting after it.
        admitsNewcomer: () => !(this.current?.isOpen && this.current.isEstablished),
        holdsApprovalFor: (port) => this.approval.holdsApprovalFor(port),
        bound: (port) => this.approval.bind(port),
        accept: (socket) => this.accept(socket),
        heartbeat: () => this.heartbeatTick(),
      },
      reclaimWindowMs,
    );
  }

  /** Bind the first free port in the block; `onConnect` runs after each connection's handshake is sent. */
  start(ports: readonly number[], onConnect?: () => void): void {
    this.onConnect = onConnect;
    this.listener.start(ports);
  }

  /** The port this bridge is listening on, or null before it binds. */
  get port(): number | null {
    return this.listener.port;
  }

  /**
   * Take an admitted socket as the holder. Anything the listener admits displaces the current holder,
   * which is by then non-established (a pre-consent squatter or a half-open dead socket) — an
   * established one is refused before a socket exists.
   */
  accept(socket: WebSocket): void {
    const previous = this.current;
    // Abandon the outgoing connection before swapping in this one: a canvas request holding for its
    // verdict is suspended on it, and wakes to re-read the slot and hold for the newcomer instead.
    previous?.abandon();
    const connection = new RelayConnection(socket);
    this.current = connection;
    this.disconnectedAt = null;
    socket.on("pong", () => connection.pong());
    socket.on("message", (data) => this.receive(connection, data.toString()));
    let disconnected = false;
    const disconnect = (): void => {
      if (disconnected) return;
      disconnected = true;
      // A displaced socket's close fires a tick AFTER the newcomer's handshake went out; failing
      // everything here would reject the newcomer's requests. Its own were failed at displacement.
      if (this.current !== connection) {
        Logger.log("Displaced WS socket closed");
        return;
      }
      this.current = null;
      this.disconnectedAt = Date.now();
      connection.abandon();
      this.ledger.fail(
        "Figma plugin disconnected before replying. Completion is unconfirmed; inspect affected nodes before retrying.",
        connection,
      );
      Logger.log("Plugin disconnected from WS bridge");
    };
    socket.on("close", disconnect);
    // Receiver errors (including maxPayload rejection) belong to the accepted socket. Settle its runs
    // now, then terminate; the ensuing close uses the same idempotent cleanup.
    socket.on("error", () => {
      disconnect();
      socket.terminate();
    });
    if (previous) {
      if (previous.isOpen)
        Logger.log("Reclaiming WS slot from a non-handshaked holder for a new connection");
      this.ledger.fail("Figma connection replaced. Completion is unconfirmed.", previous);
      previous.socket.terminate();
    }
    Logger.log("Plugin connected to WS bridge");
    // Ask what we're talking to FIRST, from here rather than the caller: holding canvas requests until
    // a verdict lands is only safe if a verdict ALWAYS lands, so the connection runs its own handshake.
    void this.handshake(connection);
    this.onConnect?.();
  }

  /**
   * One heartbeat cycle for the holder. Public so the contract harness can drive liveness
   * deterministically instead of waiting out the real interval.
   */
  heartbeatTick(): void {
    this.current?.heartbeat();
  }

  /**
   * Close the listener (freeing its port) and drop the holder. NOT part of the normal server
   * lifecycle — the relay lives for the whole process. It exists for one-shot CLI runs and for tests
   * that model a server RESTART honestly: free the port, then rebind it with a fresh bridge.
   */
  stop(): void {
    this.listener.stop();
    this.ledger.fail("Bridge stopped. Completion is unconfirmed.");
    const connection = this.current;
    this.current = null;
    connection?.abandon();
    connection?.socket.terminate();
  }

  /**
   * Where the current connection stands with the version handshake. Canvas requests hold on
   * `checking` and are refused on `incompatible`; read directly for diagnostics and by the harness.
   */
  protocolCompatibility(): ProtocolCompatibility {
    return this.current?.compatibility ?? "checking";
  }

  /**
   * The refusal text when the current connection's verdict is `incompatible`, else null. The one
   * reader that ISN'T a canvas request is the docs tool, which still serves on a stale plugin and
   * leads with the refusal so the agent learns the re-import fix before its first refused write.
   */
  protocolRefusal(): string | null {
    return this.current?.skewRefusal ?? null;
  }

  /** The current connection's pairing code, or null when no plugin is connected. */
  getPairingCode(): string | null {
    return this.current?.pairingCode ?? null;
  }

  /** The session this server holds a token for — what it presents as a prior Allow — or null. */
  approvedSession(): ApprovedSession | null {
    return this.approval.session;
  }

  /** What this server says about itself to the connected plugin: who it is, and its prior approval. */
  sessionInfo(framelinkOrigin: string): Extract<ServerRequest, { type: "SESSION_INFO" }> {
    return this.approval.sessionInfo(this.getPairingCode(), framelinkOrigin);
  }

  /** Is a plugin on the wire right now? The plain liveness question, with no approval in it. */
  isPluginConnected(): boolean {
    return this.current?.isOpen ?? false;
  }

  /** Whether the approval found at bind was used recently — see ApprovalSession.hasRecentApproval. */
  hasRecentApproval(): boolean {
    return this.approval.hasRecentApproval();
  }

  /**
   * Slide the persisted approval's TTL forward after a successful write by `session`, so an
   * actively-used session is never pruned mid-work. Called on the success path, not from `request()`
   * — only a real write counts as use.
   */
  touchApproval(session: ApprovedSession): void {
    this.approval.touch(session);
  }

  disconnectedDurationMs(): number | null {
    return this.disconnectedAt === null ? null : Date.now() - this.disconnectedAt;
  }

  /**
   * Poll the plugin's approval decision. A GRANTED carries the session this server held at that same
   * instant, so whatever it admits is attributed to the Allow that admitted it, with no second read.
   */
  async approvalStatus(signal?: AbortSignal): Promise<ApprovalStatus> {
    const reply = await this.request({ type: "APPROVAL_STATUS" }, signal);
    return reply.type === "APPROVAL_GRANTED"
      ? { type: "APPROVAL_GRANTED", session: this.approvedSession() }
      : reply;
  }

  /**
   * Send a request and resolve with its reply, admitted by the protocol's parser for that request
   * type. An ERROR reply, or one that isn't the shape its request is owed, rejects.
   *
   * `onSubmitted` receives the run id the plugin will know this request by (its correlation id),
   * just before it goes on the wire — for callers that must match a later run-scoped event to it.
   */
  request<T extends ServerRequest>(
    payload: T,
    signal?: AbortSignal,
    onSubmitted?: (runId: string) => void,
    runContext: ChannelRunContext = NO_RUN_CONTEXT,
  ): Promise<ReplyFor<T["type"]>> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    // Handshake messages send SYNCHRONOUSLY (no await before the send): the connection contract
    // depends on the newcomer's handshake being in flight before a displaced socket's close fires a
    // tick later. Everything else goes through the compatibility hold.
    const reply = HANDSHAKE_REQUESTS.has(payload.type)
      ? this.sendToHolder(payload, signal, onSubmitted, runContext)
      : this.sendOnceCompatible(payload, signal, onSubmitted, runContext);
    // Sound because the ledger resolves only what parseReply admitted for this payload's type.
    return reply as Promise<ReplyFor<T["type"]>>;
  }

  /**
   * Send a canvas request only once the holder's protocol is known to be supported: hold while its
   * verdict is `checking`, refuse when it came back mismatched.
   *
   * A LOOP, not a single await: each abandonment settles the connection's verdict promise, which
   * wakes us to re-read the slot. A reclaim mid-hold puts a fresh `checking` connection there, so we
   * hold again on the newcomer; a socket that dies drops out of the loop into the not-connected
   * rejection.
   */
  private async sendOnceCompatible(
    payload: ServerRequest,
    signal: AbortSignal | undefined,
    onSubmitted: ((runId: string) => void) | undefined,
    runContext: ChannelRunContext,
  ): Promise<PluginReply> {
    for (
      let connection = this.current;
      connection?.isOpen && connection.compatibility === "checking";
      connection = this.current
    )
      await waitForSignal(connection.verdictSettled, signal);
    // Refuse rather than send: a plugin executing agent code against a wire contract this server
    // doesn't speak is the failure the version gate exists to prevent.
    const refusal = this.current?.skewRefusal;
    if (refusal) throw new BridgeRequestError(refusal, "not-submitted");
    return this.sendToHolder(payload, signal, onSubmitted, runContext);
  }

  private sendToHolder(
    payload: ServerRequest,
    signal: AbortSignal | undefined,
    onSubmitted: ((runId: string) => void) | undefined,
    runContext: ChannelRunContext,
  ): Promise<PluginReply> {
    const connection = this.current;
    if (!connection?.isOpen)
      return Promise.reject(
        new BridgeRequestError(
          pluginDisconnectedNotSubmittedText(this.disconnectedDurationMs()),
          "not-submitted",
        ),
      );
    return this.ledger.submit(connection, payload, signal, onSubmitted, runContext);
  }

  /**
   * Ask a fresh connection for its versions and record its verdict, releasing any canvas request
   * holding for it. A plugin predating the handshake answers with an envelope ERROR, a silent one
   * times out, and a malformed answer is refused at parse — each catches into null, the protocol floor,
   * and is refused. So every path settles.
   */
  private async handshake(connection: RelayConnection): Promise<void> {
    const reply = await this.request({ type: "GET_VERSION" }).catch(() => null);
    // A displaced or disconnected connection's answer is about a socket nobody is driving: an orphaned
    // GET_VERSION resolving on its timeout must not condemn the plugin that took the slot since.
    if (this.current !== connection) return;
    const refusal = refuseProtocolSkew(reply);
    connection.decide(refusal);
    if (!refusal) return;
    Logger.log(
      `⚠️ Version skew — plugin reported ${JSON.stringify(reply)}; refusing canvas requests`,
    );
    // Human channel: a toast the plugin words itself. Fire-and-forget — a plugin predating the NOTIFY
    // handler envelope-ERRORs and the toast is dropped; the agent still gets every refusal.
    this.request({ type: "NOTIFY", serverProtocol: PROTOCOL_VERSION }).catch(() => {});
  }

  private receive(connection: RelayConnection, raw: string): void {
    // Measure the received frame, never recursively stringify parsed, untrusted input. All
    // synchronous boundary dispatch stays inside this guard, including envelope validation.
    try {
      if (Buffer.byteLength(raw) > MAX_CHANNEL_BYTES) {
        Logger.log("Ignoring oversized plugin frame");
        return;
      }
      const msg: unknown = JSON.parse(raw);
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
      this.dispatch(connection, msg as Record<string, unknown>);
    } catch {
      Logger.log("Ignoring invalid plugin message");
    }
  }

  private dispatch(connection: RelayConnection, msg: Record<string, unknown>): void {
    const event = parsePluginEvent(msg);
    if (event) {
      this.route(connection, event);
      return;
    }
    if (typeof msg.id !== "string") return;
    // A CHANNEL_REQUEST the parser refused still carries the plugin's id, and the plugin's call is
    // suspended on it: answer, or the run hangs until its own deadline.
    if (msg.type === "CHANNEL_REQUEST") {
      this.channel.refuseMalformed(connection, msg.id);
      return;
    }
    const outcome = this.ledger.settleReply(connection, msg.id, msg);
    // A reply matching its request proves the holder speaks the frozen envelope — a real plugin, not a
    // dead or mute squatter — which is what protects it from slot-reclaim, malformed or not.
    if (outcome === "settled") connection.markEstablished();
    // A run whose caller gave up still reports what it did; a Write it made is owed regardless.
    else if (outcome === "late" && connection === this.current) {
      const reply = parseExecuteCodeResult(msg);
      if (reply) this.events.onRunEvent?.({ type: "orphanReply", runId: msg.id, reply });
    }
  }

  private route<K extends PluginEventType>(
    connection: RelayConnection,
    event: Extract<PluginEvent, { type: K }>,
  ): void {
    const route: EventRoute<K> = this.routes[event.type as K];
    const apply = () => route.handle(connection, event);
    if (route.from === "any") return apply();
    if (connection !== this.current) return;
    if (route.from === "holder" || connection.compatibility === "compatible") return apply();
    // Deferred, not dropped, while the verdict is pending: the plugin can hand over a token in answer
    // to SESSION_INFO, which follows GET_VERSION closely enough to arrive before its verdict lands.
    if (connection.compatibility === "checking")
      void connection.verdictSettled
        .then(() => {
          if (connection === this.current && connection.compatibility === "compatible") apply();
        })
        .catch(() => Logger.log("Ignoring invalid plugin message"));
  }
}

/** Abort a local hold without leaving listeners behind when its gate settles. */
function waitForSignal(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, reject);
  });
}
