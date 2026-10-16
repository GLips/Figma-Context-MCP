/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { WebSocket } from "ws";
import { DEFAULT_FRAMELINK_API_URL } from "~/config.js";
import { figmaFileKey, type FigmaFileKey } from "~/utils/figma-url.js";
import { Logger } from "~/utils/logger.js";
import { pluginDisconnectedNotSubmittedText } from "./blocked-call-guidance.js";
import { targetPluginCall, type CallTarget, type CallTargetOptions } from "./call-target.js";
import { ChannelServer, type CapabilityHandler } from "./channel-server.js";
import { LinkCredentialStore } from "./link-credential.js";
import {
  LinkSetup,
  UNAUTHENTICATED_LINK_MS,
  type LinkSetupRequest,
  type PairingConfirmation,
  type PairingOffer,
} from "./link-setup.js";
import {
  DEFAULT_PROOF_TIMING,
  LinkDocuments,
  type DocumentReader,
  type LinkDocument,
  type ProofTiming,
} from "./link-documents.js";
import { canonicalProjectPath } from "./project.js";
import { RelayConnection, isSettlingLinkStage } from "./relay-connection.js";
import { MAX_CHANNEL_BYTES, RelayListener } from "./relay-listener.js";
import { RequestTrace } from "./request-trace.js";
import {
  BridgeRequestError,
  DEFAULT_RUN_CEILING_MS,
  DEFAULT_TIMEOUT_MS,
  NO_RUN_CONTEXT,
  RunLedger,
  type ChannelRunContext,
} from "./run-ledger.js";
import type { RunEvent } from "../entitlement/write-meter.js";
import {
  parseExecuteCodeResult,
  parsePluginEvent,
  type GrantPrompt,
  type GrantState,
  type LINK_SETUP_REQUEST_TYPES,
  type PluginEvent,
  type PluginEventType,
  type ReplyFor,
  type ServerRequest,
} from "@framelink/plugin/protocol";

export { BridgeRequestError, type ChannelRunContext, type RequestPhase } from "./run-ledger.js";
export type { CapabilityHandler } from "./channel-server.js";
export type { LinkStage } from "./relay-connection.js";
export type { CallDocument, CallTarget, CallTargetBlock } from "./call-target.js";
export type { DocumentReader, LinkDocument } from "./link-documents.js";
export type { PairingConfirmation, PairingOffer } from "./link-setup.js";

/** One plugin link: a socket from one plugin incarnation, in whatever stage of setup it reached. */
export type PluginLink = RelayConnection;

/** Every request an authenticated link may be sent; the setup envelope is the bridge's own to send. */
export type LinkRequest = Exclude<
  ServerRequest,
  { type: (typeof LINK_SETUP_REQUEST_TYPES)[number] }
>;

/** Unsolicited plugin events the bridge relays but doesn't own. All come from authenticated links. */
export interface PluginBridgeEvents {
  /** A link proved it holds the installation credential: introduce this server to it. */
  onLinkAuthenticated?: (link: PluginLink) => void;
  /** The human granted or revoked this project a document in this link's plugin. */
  onGrantChanged?: (link: PluginLink, granted: boolean) => void;
  /** The human clicked the panel's sign-in button in this link's plugin. */
  onWriteAccessSignIn?: (link: PluginLink) => void;
  /**
   * What a link says about a run outside its caller's reply: RUN_CHANGED, RUN_SETTLED, or a result
   * that arrived after the caller gave up. Forwarded as-is — what it costs is the write meter's
   * call. May fire more than once for a run, and for run ids this server never issued.
   */
  onRunEvent?: (event: RunEvent) => void;
}

/**
 * Whether a call that needs the plugin has links to run on: every authenticated one. Which of them
 * it runs on is the document's question (targetCall), never the link's.
 */
export type LinkResolution =
  | { kind: "linked"; links: PluginLink[] }
  | { kind: "unpaired" }
  | { kind: "credential-unusable"; problem: string }
  | { kind: "incompatible"; refusal: string }
  | { kind: "disconnected"; elapsedMs: number | null };

/** Every way a call can resolve no link. */
export type UnlinkedResolution = Exclude<LinkResolution, { kind: "linked" }>;

type EventRoutes = {
  [K in PluginEventType]: (link: PluginLink, event: Extract<PluginEvent, { type: K }>) => void;
};

/**
 * The relay to the Figma plugin: every plugin link, and the composition of its parts — the listener
 * (network edge), the run ledger (requests and their clocks), the channel server (the reverse
 * direction), link setup (HELLO, AUTHENTICATE and pairing), and link documents (which file each link
 * is in). It keeps no grant state: the plugin alone stores grants, and is asked on every call.
 *
 * Until a link authenticates it is sent only the setup envelope, and nothing it sends but replies
 * to that is heard.
 */
export class PluginBridge {
  private readonly links = new Set<RelayConnection>();
  private disconnectedAt: number | null = null;
  private onConnect: (() => void) | undefined;
  private readonly connectionWaiters = new Set<() => void>();
  private readonly listener: RelayListener;
  private readonly ledger: RunLedger;
  private readonly channel: ChannelServer;
  private readonly setup: LinkSetup;
  private readonly documents: LinkDocuments;
  private readonly documentReader: DocumentReader | null;
  private readonly events: PluginBridgeEvents;

  private readonly routes: EventRoutes = {
    RUN_TRACE: (link, event) => this.ledger.trace.recordHost(event.runId, link, event),
    // Every other plugin instance of the same owner re-reads its storage: one file open in two
    // instances must honor a grant or revoke made in either.
    GRANT_CHANGED: (link, event) => {
      for (const other of this.authenticatedLinks())
        if (other !== link && other.owner?.figmaUserId === link.owner?.figmaUserId)
          this.request(other, {
            type: "GRANT_CHANGED_ELSEWHERE",
            project: event.project,
            fileKey: event.fileKey,
          }).catch(() => {});
      this.events.onGrantChanged?.(link, event.granted);
    },
    // The plugin's word, already admitted as a wire file key by the protocol's parser.
    DOCUMENT_CLAIMED: (link, event) => this.documents.claimed(link, figmaFileKey(event.fileKey)),
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

  // Everything injectable for the tests and the contract harness: `linkCredentials` isolates
  // persistence to a temp dir; `project` stands in for the cwd; `documentReader` for Figma's REST
  // API; the clocks let them pin timeout behaviour without waiting out the real deadlines; `trace`
  // lets a test read what the trace kept. Production takes the defaults, and index.ts registers the
  // production capability allowlist and the reader.
  constructor({
    linkCredentials = new LinkCredentialStore(),
    project = canonicalProjectPath(),
    framelinkOrigin = new URL(DEFAULT_FRAMELINK_API_URL).origin,
    documentReader = null,
    proofTiming = DEFAULT_PROOF_TIMING,
    requestTimeoutMs = DEFAULT_TIMEOUT_MS,
    runCeilingMs = DEFAULT_RUN_CEILING_MS,
    unauthenticatedLinkMs = UNAUTHENTICATED_LINK_MS,
    capabilities = new Map(),
    events = {},
    trace = new RequestTrace((event) => Logger.log("Bridge trace " + JSON.stringify(event))),
  }: {
    linkCredentials?: LinkCredentialStore;
    project?: string;
    framelinkOrigin?: string;
    /** Reads files to prove links no call asked about yet. Null: only a call's reader proves. */
    documentReader?: DocumentReader | null;
    proofTiming?: ProofTiming;
    requestTimeoutMs?: number;
    runCeilingMs?: number;
    unauthenticatedLinkMs?: number;
    capabilities?: ReadonlyMap<string, CapabilityHandler>;
    events?: PluginBridgeEvents;
    trace?: RequestTrace;
  } = {}) {
    this.events = events;
    this.documentReader = documentReader;
    this.ledger = new RunLedger({
      requestTimeoutMs,
      runCeilingMs,
      trace,
      disconnectedDurationMs: () => this.disconnectedDurationMs(),
    });
    this.setup = new LinkSetup({
      credentials: linkCredentials,
      unauthenticatedLinkMs,
      links: () => this.links,
      // Sound because the ledger resolves only what parseReply admitted for this payload's type.
      send: <T extends LinkSetupRequest>(link: PluginLink, payload: T) =>
        this.ledger.submit(link, payload, undefined, undefined, NO_RUN_CONTEXT) as Promise<
          ReplyFor<T["type"]>
        >,
      onAuthenticated: (link) => {
        this.documents.introduce(link);
        this.events.onLinkAuthenticated?.(link);
      },
    });
    this.documents = new LinkDocuments({
      send: (link, payload) => this.request(link, payload),
      reader: documentReader,
      timing: proofTiming,
      project,
      framelinkOrigin,
    });
    this.channel = new ChannelServer(capabilities, this.ledger, (link) => this.isLive(link));
    this.listener = new RelayListener({
      admitsNewcomer: () => this.setup.makeRoomForNewcomer(),
      accept: (socket) => this.accept(socket),
      heartbeat: () => this.heartbeatTick(),
    });
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
    this.setup.admit(link);
    this.onConnect?.();
    for (const wake of this.connectionWaiters) wake();
    this.connectionWaiters.clear();
  }

  /** Resolves once any plugin is on the wire: now, or at the next accepted socket. */
  whenPluginConnected(signal: AbortSignal): Promise<void> {
    if (this.isPluginConnected()) return Promise.resolve();
    let wake!: () => void;
    const connected = new Promise<void>((resolve) => (wake = resolve));
    this.connectionWaiters.add(wake);
    const forget = () => this.connectionWaiters.delete(wake);
    signal.addEventListener("abort", forget, { once: true });
    return waitForSignal(connected, signal).finally(() =>
      signal.removeEventListener("abort", forget),
    );
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
   * Whether a call has links to run on. Links a credential failed are challenged again first, and
   * links still setting up are waited out rather than guessed about.
   */
  async resolveLink(signal?: AbortSignal): Promise<LinkResolution> {
    this.setup.rechallenge();
    for (;;) {
      const settling = [...this.links].filter(
        (link) => link.isOpen && isSettlingLinkStage(link.stage),
      );
      if (!settling.length) break;
      await waitForSignal(Promise.race(settling.map((link) => link.stageChanged)), signal);
    }
    const open = [...this.links].filter((link) => link.isOpen);
    const authenticated = open.filter((link) => link.isAuthenticated);
    if (authenticated.length) return { kind: "linked", links: authenticated };
    // Ahead of unpaired: with no usable credential, no link could pass, and pairing can't help.
    for (const link of open)
      if (link.stage.kind === "credential-unusable")
        return { kind: "credential-unusable", problem: link.stage.problem };
    if (open.some((link) => link.stage.kind === "unpaired")) return { kind: "unpaired" };
    for (const link of open)
      if (link.stage.kind === "incompatible")
        return { kind: "incompatible", refusal: link.stage.refusal };
    return { kind: "disconnected", elapsedMs: this.disconnectedDurationMs() };
  }

  /** Show a pairing code in every unpaired link's panel — see LinkSetup.offer. */
  offerPairing(): Promise<PairingOffer> {
    return this.setup.offer();
  }

  /** Pair the one link showing `typedCode`, and only that one — see LinkSetup.confirm. */
  confirmPairing(typedCode: string): Promise<PairingConfirmation> {
    return this.setup.confirm(typedCode);
  }

  /** The human said a panel doesn't show `typedCode`: that attempt ends, and its panel stops showing it. */
  declinePairing(typedCode: string): void {
    this.setup.decline(typedCode);
  }

  /** When the attempt showing `typedCode` expires, or null when no open link shows it. */
  pairingCodeExpiresAt(typedCode: string): number | null {
    return this.setup.pairingCodeExpiresAt(typedCode);
  }

  /**
   * The one document a call runs against, and the link to run it on — see call-target.ts. `fileKey`
   * null lets the human pick. Prompts in the plugin; submits nothing.
   */
  targetCall(
    fileKey: FigmaFileKey | null,
    options: Omit<CallTargetOptions, "reader"> & { reader?: DocumentReader | null },
  ): Promise<CallTarget> {
    return targetPluginCall(
      {
        links: () => this.authenticatedLinks(),
        documents: this.documents,
        askGrant: (link, key, prompt, signal) => this.grantStatus(link, key, prompt, signal),
        closePrompt: (link) => {
          this.request(link, { type: "GRANT_PROMPT_CLOSED" }).catch(() => {});
        },
      },
      fileKey,
      { ...options, reader: options.reader ?? this.documentReader },
    );
  }

  /** Which file `link` is in, as far as this server knows. */
  documentOf(link: PluginLink): LinkDocument {
    return this.documents.documentOf(link);
  }

  /** Ask a link's plugin whether this project holds a grant on `fileKey`, prompting as `prompt` says. */
  async grantStatus(
    link: PluginLink,
    fileKey: string | null,
    prompt: GrantPrompt,
    signal?: AbortSignal,
  ): Promise<GrantState> {
    const reply = await this.request(link, { type: "GRANT_STATUS", fileKey, prompt }, { signal });
    return reply.state;
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

  private isLive(link: PluginLink): boolean {
    return this.links.has(link) && link.isOpen && link.isAuthenticated;
  }

  private drop(link: PluginLink): void {
    if (!this.links.delete(link)) return;
    this.setup.forget(link);
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
