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
import { LinkCredentialStore, mintLinkNonce } from "./link-credential.js";
import { PairingAttempts, normalizePairingCode } from "./link-pairing.js";
import { RelayConnection, isSettlingLinkStage } from "./relay-connection.js";
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
import { refuseProtocolSkew } from "./version.js";
import type { RunEvent } from "../entitlement/write-meter.js";
import {
  PROTOCOL_VERSION,
  parseExecuteCodeResult,
  parsePluginEvent,
  type LINK_SETUP_REQUEST_TYPES,
  type PendingApprovalReply,
  type PluginEvent,
  type PluginEventType,
  type ReplyFor,
  type ServerRequest,
} from "@framelink/plugin/protocol";

export { BridgeRequestError, type ChannelRunContext, type RequestPhase } from "./run-ledger.js";
export type { CapabilityHandler } from "./channel-server.js";
export type { LinkStage } from "./relay-connection.js";

/** One plugin link: a socket from one plugin incarnation, in whatever stage of setup it reached. */
export type PluginLink = RelayConnection;

/** Every request an authenticated link may be sent; the setup envelope is the bridge's own to send. */
export type LinkRequest = Exclude<
  ServerRequest,
  { type: (typeof LINK_SETUP_REQUEST_TYPES)[number] }
>;
type SetupRequest = Extract<ServerRequest, { type: (typeof LINK_SETUP_REQUEST_TYPES)[number] }>;

/** Unsolicited plugin events the bridge relays but doesn't own. All come from authenticated links. */
export interface PluginBridgeEvents {
  /** A link proved it holds the installation credential: introduce this server to it. */
  onLinkAuthenticated?: (link: PluginLink) => void;
  /** The human clicked Allow for this server in this link's plugin. */
  onSessionApproved?: (link: PluginLink) => void;
  /** The human clicked the panel's sign-in button in this link's plugin. */
  onWriteAccessSignIn?: (link: PluginLink) => void;
  /**
   * What a link says about a run outside its caller's reply: RUN_CHANGED, RUN_SETTLED, or a result
   * that arrived after the caller gave up. Forwarded as-is — what it costs is the write meter's
   * call. May fire more than once for a run, and for run ids this server never issued.
   */
  onRunEvent?: (event: RunEvent) => void;
}

/** The plugin's answer to an approval poll, with the session a GRANTED admits read at that instant. */
export type ApprovalStatus =
  | { type: "APPROVAL_GRANTED"; session: ApprovedSession | null }
  | PendingApprovalReply
  | { type: "APPROVAL_REJECTED" };

/**
 * Which link a call that needs the plugin runs on. Until calls can name their document, exactly one
 * authenticated link resolves, and several refuse rather than pick: picking is the wrong-file hazard.
 */
export type LinkResolution =
  | { kind: "linked"; link: PluginLink }
  | { kind: "unpaired" }
  | { kind: "several"; count: number }
  | { kind: "incompatible"; refusal: string }
  | { kind: "disconnected"; elapsedMs: number | null };

/** What an offer to pair put in front of the human: the codes the panels now show. */
export type PairingOffer =
  | { kind: "offered"; attempts: { code: string; expiresAt: number }[] }
  | { kind: "rate-limited"; retryAfterMs: number }
  | { kind: "none" };

export type PairingConfirmation =
  | { kind: "paired"; link: PluginLink }
  | { kind: "unknown-code" }
  | { kind: "failed"; reason: string };

// Links that haven't authenticated, at once. A real one is a plugin instance per open file, so this
// is generous. Past it, a newcomer evicts the oldest one showing no pairing code: a flood of mute
// sockets can't lock out a plugin that redials, and authenticated links never count or go.
const MAX_UNAUTHENTICATED_LINKS = 8;

// How long a link may sit without authenticating, unless a pairing attempt on it runs longer. The
// plugin redials at once when closed, so this only recycles links, never strands a real plugin.
const UNAUTHENTICATED_LINK_MS = 10 * 60 * 1000;

type EventRoutes = {
  [K in PluginEventType]: (link: PluginLink, event: Extract<PluginEvent, { type: K }>) => void;
};

/**
 * The relay to the Figma plugin: every plugin link, and the composition of its parts — the listener
 * (network edge), the run ledger (requests and their clocks), the channel server (the reverse
 * direction), the approval session (what this server presents and persists), and link setup.
 *
 * Every link sets itself up the same way: HELLO (an exact protocol check), then AUTHENTICATE (proof
 * it holds this state dir's installation credential). Until a link authenticates it is sent only
 * that envelope and the pairing frames, and nothing it sends but replies to them is heard.
 */
export class PluginBridge {
  private readonly links = new Set<RelayConnection>();
  private disconnectedAt: number | null = null;
  private onConnect: (() => void) | undefined;
  private readonly setupDeadlines = new Map<RelayConnection, ReturnType<typeof setTimeout>>();
  private readonly listener: RelayListener;
  private readonly ledger: RunLedger;
  private readonly channel: ChannelServer;
  private readonly approval: ApprovalSession;
  private readonly credentials: LinkCredentialStore;
  private readonly attempts = new PairingAttempts<RelayConnection>();
  private readonly unauthenticatedLinkMs: number;
  private readonly events: PluginBridgeEvents;

  private readonly routes: EventRoutes = {
    RUN_TRACE: (link, event) => this.ledger.trace.recordHost(event.runId, link, event),
    SESSION_TOKEN: (link, event) => {
      this.approval.apply({ type: "handedOver", session: { token: event.sessionToken } });
      this.events.onSessionApproved?.(link);
    },
    SESSION_CLAIM: (_, event) =>
      this.approval.apply({ type: "claimed", claim: event.sessionClaim }),
    REVOKE_SESSION: () => this.approval.apply({ type: "revoked" }),
    WRITE_ACCESS_SIGN_IN: (link) => this.events.onWriteAccessSignIn?.(link),
    CHANNEL_REQUEST: (link, event) => this.channel.serve(link, event),
    RUN_STATE: (link, event) => this.ledger.runState(link, event),
    // Run-scoped, so it settles here rather than through the correlated-reply path.
    CANCEL_RESULT: (link, event) =>
      this.ledger.settleCancelAnswer(event.runId, event.disposition, link),
    // Metering outlives the caller, so these go to the meter, never to the run's caller.
    RUN_CHANGED: (_, event) => this.events.onRunEvent?.({ type: "changed", runId: event.runId }),
    RUN_SETTLED: (_, event) => this.events.onRunEvent?.({ type: "settled", runId: event.runId }),
  };

  // Everything injectable for the tests and the contract harness: `store` and `linkCredentials`
  // isolate persistence to a temp dir; the clocks let them pin timeout behaviour without waiting out
  // the real deadlines; `trace` lets a test read what the trace kept. Production takes the defaults,
  // and index.ts registers the production capability allowlist.
  constructor(
    store: ApprovalStore = new ApprovalStore(),
    {
      linkCredentials = new LinkCredentialStore(),
      requestTimeoutMs = DEFAULT_TIMEOUT_MS,
      runCeilingMs = DEFAULT_RUN_CEILING_MS,
      reclaimWindowMs = RECLAIM_WINDOW_MS,
      unauthenticatedLinkMs = UNAUTHENTICATED_LINK_MS,
      capabilities = new Map(),
      events = {},
      trace = new RequestTrace((event) => Logger.log("Bridge trace " + JSON.stringify(event))),
    }: {
      linkCredentials?: LinkCredentialStore;
      requestTimeoutMs?: number;
      runCeilingMs?: number;
      reclaimWindowMs?: number;
      unauthenticatedLinkMs?: number;
      capabilities?: ReadonlyMap<string, CapabilityHandler>;
      events?: PluginBridgeEvents;
      trace?: RequestTrace;
    } = {},
  ) {
    this.events = events;
    this.credentials = linkCredentials;
    this.unauthenticatedLinkMs = unauthenticatedLinkMs;
    this.approval = new ApprovalSession(store);
    this.ledger = new RunLedger({
      requestTimeoutMs,
      runCeilingMs,
      trace,
      disconnectedDurationMs: () => this.disconnectedDurationMs(),
    });
    this.channel = new ChannelServer(capabilities, this.ledger, (link) => this.isLive(link));
    this.listener = new RelayListener(
      {
        admitsNewcomer: () => this.makeRoomForNewcomer(),
        holdsApprovalFor: (port) => this.approval.holdsApprovalFor(port),
        bound: (port) => this.approval.bind(port),
        accept: (socket) => this.accept(socket),
        heartbeat: () => this.heartbeatTick(),
      },
      reclaimWindowMs,
    );
  }

  /** Bind the first free port in the block; `onConnect` runs as each socket is accepted. */
  start(ports: readonly number[], onConnect?: () => void): void {
    this.onConnect = onConnect;
    this.listener.start(ports);
  }

  /** The port this bridge is listening on, or null before it binds. */
  get port(): number | null {
    return this.listener.port;
  }

  /** Take an admitted socket as a new link, and set it up. */
  accept(socket: WebSocket): void {
    const link = new RelayConnection(socket);
    this.links.add(link);
    this.disconnectedAt = null;
    socket.on("pong", () => link.pong());
    socket.on("message", (data) => this.receive(link, data.toString()));
    let disconnected = false;
    const disconnect = (): void => {
      if (disconnected) return;
      disconnected = true;
      this.drop(link);
    };
    socket.on("close", disconnect);
    // Receiver errors (including maxPayload rejection) belong to the accepted socket. Settle its runs
    // now, then terminate; the ensuing close uses the same idempotent cleanup.
    socket.on("error", () => {
      disconnect();
      socket.terminate();
    });
    Logger.log("Plugin connected to WS bridge");
    this.armSetupDeadline(link, this.unauthenticatedLinkMs);
    void this.setUp(link);
    this.onConnect?.();
  }

  /**
   * One heartbeat cycle for every link. Public so the contract harness can drive liveness
   * deterministically instead of waiting out the real interval.
   */
  heartbeatTick(): void {
    for (const link of this.links) link.heartbeat();
  }

  /**
   * Close the listener (freeing its port) and drop every link. NOT part of the normal server
   * lifecycle — the relay lives for the whole process. It exists for one-shot CLI runs and for tests
   * that model a server RESTART honestly: free the port, then rebind it with a fresh bridge.
   */
  stop(): void {
    this.listener.stop();
    this.ledger.fail("Bridge stopped. Completion is unconfirmed.");
    for (const link of [...this.links]) {
      this.drop(link);
      link.socket.terminate();
    }
  }

  /** Every link that has authenticated and is still open. */
  authenticatedLinks(): PluginLink[] {
    return [...this.links].filter((link) => this.isLive(link));
  }

  /** Is any plugin on the wire right now, authenticated or not? The plain liveness question. */
  isPluginConnected(): boolean {
    return [...this.links].some((link) => link.isOpen);
  }

  disconnectedDurationMs(): number | null {
    if (this.isPluginConnected() || this.disconnectedAt === null) return null;
    return Date.now() - this.disconnectedAt;
  }

  /**
   * Which link a call runs on. Unpaired links are challenged again first, since a credential another
   * server or plugin instance provisioned since may now pass, and links still setting up are waited
   * out rather than guessed about.
   */
  async resolveLink(signal?: AbortSignal): Promise<LinkResolution> {
    for (const link of this.links)
      if (link.isOpen && link.stage.kind === "unpaired") void this.authenticate(link);
    for (;;) {
      const settling = [...this.links].filter(
        (link) => link.isOpen && isSettlingLinkStage(link.stage),
      );
      if (!settling.length) break;
      await waitForSignal(Promise.race(settling.map((link) => link.stageChanged)), signal);
    }
    const open = [...this.links].filter((link) => link.isOpen);
    const authenticated = open.filter((link) => link.isAuthenticated);
    if (authenticated.length === 1) return { kind: "linked", link: authenticated[0] };
    if (authenticated.length > 1) return { kind: "several", count: authenticated.length };
    if (open.some((link) => link.stage.kind === "unpaired")) return { kind: "unpaired" };
    for (const link of open)
      if (link.stage.kind === "incompatible")
        return { kind: "incompatible", refusal: link.stage.refusal };
    return { kind: "disconnected", elapsedMs: this.disconnectedDurationMs() };
  }

  /**
   * Show a pairing code in every unpaired link's panel: the link's open attempt, or a fresh one.
   * Resolves once each panel acknowledged its code, so the human can see what the agent is told.
   */
  async offerPairing(): Promise<PairingOffer> {
    const unpaired = [...this.links].filter(
      (link) => link.isOpen && link.stage.kind === "unpaired",
    );
    if (!unpaired.length) return { kind: "none" };
    const offered = await Promise.all(
      unpaired.map(async (link) => {
        const open = this.attempts.of(link);
        if (open) return { code: open.code, expiresAt: open.expiresAt };
        const attempt = this.attempts.start(link);
        if (!attempt) return null;
        const expiresInMs = attempt.expiresAt - Date.now();
        // The link lives at least as long as the code it shows.
        this.armSetupDeadline(link, expiresInMs);
        try {
          await this.sendSetup(link, { type: "PAIRING_OFFER", code: attempt.code, expiresInMs });
        } catch {
          this.attempts.end(link);
          return null;
        }
        return { code: attempt.code, expiresAt: attempt.expiresAt };
      }),
    );
    const attempts = offered.filter((attempt) => attempt !== null);
    if (attempts.length) return { kind: "offered", attempts };
    const retryAfterMs = this.attempts.retryAfterMs();
    return retryAfterMs > 0 ? { kind: "rate-limited", retryAfterMs } : { kind: "none" };
  }

  /**
   * The human confirmed that a panel shows `typedCode`: provision the installation credential to the
   * one link showing it, and authenticate that link. Never pairs a link showing any other code.
   */
  async confirmPairing(typedCode: string): Promise<PairingConfirmation> {
    const code = normalizePairingCode(typedCode);
    const attempt = code === null ? undefined : this.attempts.showing(code);
    if (!attempt || !attempt.link.isOpen) return { kind: "unknown-code" };
    const { link } = attempt;
    // One confirmation per code: it is spent here, whatever happens next.
    this.attempts.end(link);
    const credential = this.credentials.readOrCreate();
    try {
      await this.sendSetup(link, {
        type: "PAIR_CONFIRMED",
        code: attempt.code,
        credentialId: credential.id,
        secret: credential.secret,
      });
    } catch (error) {
      return { kind: "failed", reason: (error as Error).message };
    }
    await this.authenticate(link);
    if (!link.isAuthenticated)
      return {
        kind: "failed",
        reason: "The plugin stored the pairing but didn't prove it on the next challenge.",
      };
    // Other instances of the same installation share its storage, so they pass now too.
    for (const other of this.links)
      if (other.isOpen && other.stage.kind === "unpaired") void this.authenticate(other);
    return { kind: "paired", link };
  }

  /** The human said a panel doesn't show `typedCode`: that attempt ends, and its panel stops showing it. */
  declinePairing(typedCode: string): void {
    const code = normalizePairingCode(typedCode);
    const attempt = code === null ? undefined : this.attempts.showing(code);
    if (!attempt) return;
    this.attempts.end(attempt.link);
    this.sendSetup(attempt.link, { type: "PAIRING_CLOSED", code: attempt.code }).catch(() => {});
  }

  /** The session this server holds a token for — what it presents as a prior Allow — or null. */
  approvedSession(): ApprovedSession | null {
    return this.approval.session;
  }

  /** What this server says about itself to an authenticated link: who it is, and its prior approval. */
  sessionInfo(framelinkOrigin: string): Extract<ServerRequest, { type: "SESSION_INFO" }> {
    return this.approval.sessionInfo(framelinkOrigin);
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

  /**
   * Poll a link's approval decision. A GRANTED carries the session this server held at that same
   * instant, so whatever it admits is attributed to the Allow that admitted it, with no second read.
   */
  async approvalStatus(link: PluginLink, signal?: AbortSignal): Promise<ApprovalStatus> {
    const reply = await this.request(link, { type: "APPROVAL_STATUS" }, { signal });
    return reply.type === "APPROVAL_GRANTED"
      ? { type: "APPROVAL_GRANTED", session: this.approvedSession() }
      : reply;
  }

  /**
   * Send a request on an authenticated link and resolve with its reply, admitted by the protocol's
   * parser for that request type. An ERROR reply, or one that isn't the shape its request is owed,
   * rejects. A link that dropped or never authenticated is refused before anything is sent.
   *
   * `onSubmitted` receives the run id the plugin will know this request by (its correlation id),
   * just before it goes on the wire — for callers that must match a later run-scoped event to it.
   */
  request<T extends LinkRequest>(
    link: PluginLink,
    payload: T,
    {
      signal,
      onSubmitted,
      runContext = NO_RUN_CONTEXT,
    }: {
      signal?: AbortSignal;
      onSubmitted?: (runId: string) => void;
      runContext?: ChannelRunContext;
    } = {},
  ): Promise<ReplyFor<T["type"]>> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!this.isLive(link))
      return Promise.reject(
        new BridgeRequestError(
          pluginDisconnectedNotSubmittedText(this.disconnectedDurationMs()),
          "not-submitted",
        ),
      );
    // Sound because the ledger resolves only what parseReply admitted for this payload's type.
    return this.ledger.submit(link, payload, signal, onSubmitted, runContext) as Promise<
      ReplyFor<T["type"]>
    >;
  }

  private sendSetup<T extends SetupRequest>(
    link: PluginLink,
    payload: T,
  ): Promise<ReplyFor<T["type"]>> {
    return this.ledger.submit(link, payload, undefined, undefined, NO_RUN_CONTEXT) as Promise<
      ReplyFor<T["type"]>
    >;
  }

  private isLive(link: PluginLink): boolean {
    return this.links.has(link) && link.isOpen && link.isAuthenticated;
  }

  private makeRoomForNewcomer(): boolean {
    const waiting = [...this.links].filter((link) => link.isOpen && !link.isAuthenticated);
    if (waiting.length < MAX_UNAUTHENTICATED_LINKS) return true;
    // Oldest first: the set iterates in insertion order.
    const evictable = waiting.find((link) => !this.attempts.of(link));
    if (!evictable) return false;
    Logger.log("Too many plugin links waiting to authenticate — closing the oldest");
    evictable.socket.terminate();
    return true;
  }

  /**
   * HELLO, then AUTHENTICATE. A plugin predating HELLO answers with an envelope ERROR, a silent one
   * times out, and a malformed answer is refused at parse — each reads as the protocol floor and is
   * refused, so every link settles. A mismatched build was told by HELLO itself to re-import (the
   * plugin words that toast) and is sent nothing more.
   */
  private async setUp(link: PluginLink): Promise<void> {
    const hello = await this.sendSetup(link, {
      type: "HELLO",
      serverProtocol: PROTOCOL_VERSION,
    }).catch(() => null);
    if (!link.isOpen) return;
    const refusal = refuseProtocolSkew(hello);
    if (refusal) {
      Logger.log(
        `⚠️ Version skew — plugin reported ${JSON.stringify(hello)}; it will not be driven`,
      );
      link.advance({ kind: "incompatible", refusal });
      return;
    }
    await this.authenticate(link);
  }

  /**
   * Challenge a link for the installation credential, read fresh so a credential another process
   * created is the one checked. A wrong proof or a silent link is closed: neither is a plugin that
   * merely hasn't paired, which answers LINK_UNPAIRED.
   */
  private async authenticate(link: PluginLink): Promise<void> {
    if (link.stage.kind === "authenticating") return link.stageChanged;
    link.advance({ kind: "authenticating" });
    const credential = this.credentials.readOrCreate();
    const nonce = mintLinkNonce();
    const reply = await this.sendSetup(link, {
      type: "AUTHENTICATE",
      credentialId: credential.id,
      nonce,
    }).catch(() => null);
    if (!link.isOpen) return;
    if (reply?.type === "LINK_UNPAIRED") {
      link.advance({ kind: "unpaired" });
      return;
    }
    if (
      reply?.type !== "LINK_PROOF" ||
      !this.credentials.verify(credential.id, nonce, reply.proof)
    ) {
      Logger.log("A plugin link failed its authentication challenge — closing it");
      link.socket.terminate();
      return;
    }
    this.attempts.end(link);
    clearTimeout(this.setupDeadlines.get(link));
    this.setupDeadlines.delete(link);
    link.advance({ kind: "authenticated", owner: reply.owner });
    Logger.log(
      `Plugin link authenticated (${reply.owner ? reply.owner.name || "a Figma user" : "no Figma user"})`,
    );
    this.events.onLinkAuthenticated?.(link);
  }

  /** Close a link that hasn't authenticated by `ms` from now, unless its pairing attempt runs longer. */
  private armSetupDeadline(link: PluginLink, ms: number): void {
    clearTimeout(this.setupDeadlines.get(link));
    const timer = setTimeout(() => {
      this.setupDeadlines.delete(link);
      if (link.isAuthenticated || !link.isOpen) return;
      const attempt = this.attempts.of(link);
      if (attempt) return this.armSetupDeadline(link, attempt.expiresAt - Date.now());
      Logger.log("A plugin link didn't authenticate in time — closing it");
      link.socket.terminate();
    }, ms);
    timer.unref();
    this.setupDeadlines.set(link, timer);
  }

  private drop(link: PluginLink): void {
    if (!this.links.delete(link)) return;
    clearTimeout(this.setupDeadlines.get(link));
    this.setupDeadlines.delete(link);
    this.attempts.end(link);
    link.abandon();
    if (!this.isPluginConnected()) this.disconnectedAt = Date.now();
    this.ledger.fail(
      "Figma plugin disconnected before replying. Completion is unconfirmed; inspect affected nodes before retrying.",
      link,
    );
    Logger.log("Plugin disconnected from WS bridge");
  }

  private receive(link: PluginLink, raw: string): void {
    // Measure the received frame, never recursively stringify parsed, untrusted input. All
    // synchronous boundary dispatch stays inside this guard, including envelope validation.
    try {
      if (Buffer.byteLength(raw) > MAX_CHANNEL_BYTES) {
        Logger.log("Ignoring oversized plugin frame");
        return;
      }
      const msg: unknown = JSON.parse(raw);
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
      this.dispatch(link, msg as Record<string, unknown>);
    } catch {
      Logger.log("Ignoring invalid plugin message");
    }
  }

  private dispatch(link: PluginLink, msg: Record<string, unknown>): void {
    const event = parsePluginEvent(msg);
    if (event) {
      // Events are heard only from authenticated links: the setup envelope is all a link that
      // hasn't proved itself takes part in.
      if (this.isLive(link)) this.route(link, event);
      return;
    }
    if (typeof msg.id !== "string") return;
    // A CHANNEL_REQUEST the parser refused still carries the plugin's id, and the plugin's call is
    // suspended on it: answer, or the run hangs until its own deadline.
    if (msg.type === "CHANNEL_REQUEST") {
      if (this.isLive(link)) this.channel.refuseMalformed(link, msg.id);
      return;
    }
    const outcome = this.ledger.settleReply(link, msg.id, msg);
    // A run whose caller gave up still reports what it did; a Write it made is owed regardless.
    if (outcome === "late" && this.isLive(link)) {
      const reply = parseExecuteCodeResult(msg);
      if (reply) this.events.onRunEvent?.({ type: "orphanReply", runId: msg.id, reply });
    }
  }

  private route<K extends PluginEventType>(
    link: PluginLink,
    event: Extract<PluginEvent, { type: K }>,
  ): void {
    (this.routes[event.type as K] as EventRoutes[K])(link, event);
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
