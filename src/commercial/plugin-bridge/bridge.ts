/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { WebSocket } from "ws";
import { DEFAULT_FRAMELINK_API_URL } from "~/config.js";
import { Logger } from "~/utils/logger.js";
import { pluginDisconnectedNotSubmittedText } from "./blocked-call-guidance.js";
import {
  targetPluginCall,
  type CallTarget,
  type CallTargetOptions,
  type CallTargetRequest,
  type GrantStatusRequest,
} from "./call-target.js";
import {
  openDocumentSnapshot,
  type OpenDocumentSnapshot,
  type OpenFilesLookup,
} from "./open-files.js";
import { ChannelServer, type CapabilityHandler } from "./channel-server.js";
import { LinkCredentialStore } from "./link-credential.js";
import {
  LinkSetup,
  UNAUTHENTICATED_LINK_MS,
  type LinkSetupRequest,
  type PairingConfirmation,
  type PairingOffer,
} from "./link-setup.js";
import { LinkDocuments, type LinkDocument } from "./link-documents.js";
import { PluginLinkup } from "./plugin-linkup.js";
import { canonicalProjectPath } from "./project.js";
import { RelayConnection, isSettlingLinkStage } from "./relay-connection.js";
import { MAX_CHANNEL_BYTES, RelayListener } from "./relay-listener.js";
import { RequestTrace } from "./request-trace.js";
import {
  BridgeRequestError,
  NON_RUN_REQUEST_TIMEOUT_MS,
  type LedgerSubmitOptions,
  type RunState,
  RunLedger,
} from "./run-ledger.js";
import type { ExecutionId } from "~/commercial/execution-id.js";
import {
  parsePluginEvent,
  type AnnotationCursor,
  type GrantState,
  type LINK_SETUP_REQUEST_TYPES,
  type PluginEvent,
  type PluginEventType,
  type ReplyFor,
  type RUN_REQUEST_TYPES,
  type ServerRequest,
  type WithdrawOutcome,
} from "@framelink/plugin/protocol";

export {
  BridgeRequestError,
  type ChannelRunContext,
  type RunState,
  type RunWaiting,
  type RunWatch,
} from "./run-ledger.js";
export type { CapabilityHandler } from "./channel-server.js";
export type { LinkStage } from "./relay-connection.js";
export type {
  CallDocument,
  CallTarget,
  CallTargetBlock,
  CallTargetRequest,
} from "./call-target.js";
export type { OpenDocument, OpenDocumentSnapshot } from "./open-files.js";
export type { LinkDocument, OpenFile } from "./link-documents.js";
export type { PairingConfirmation, PairingOffer } from "./link-setup.js";

/** One plugin link: a socket from one plugin incarnation, in whatever stage of setup it reached. */
export type PluginLink = RelayConnection;

/** Every request an authenticated link may be sent; the setup envelope is the bridge's own to send. */
export type LinkRequest = Exclude<
  ServerRequest,
  { type: (typeof LINK_SETUP_REQUEST_TYPES)[number] }
>;

/** The requests the plugin runs as executions, each sent under the execution id its caller minted. */
export type RunRequest = Extract<LinkRequest, { type: (typeof RUN_REQUEST_TYPES)[number] }>;

/** Unsolicited plugin events the bridge relays but doesn't own. All come from authenticated links. */
export interface PluginBridgeEvents {
  /** A link proved it holds the installation credential: introduce this server to it. */
  onLinkAuthenticated?: (link: PluginLink) => void;
  /** The human granted or revoked this project a document in this link's plugin. */
  onGrantChanged?: (link: PluginLink, granted: boolean) => void;
  /** The human clicked the panel's sign-in button in this link's plugin. */
  onWriteAccessSignIn?: (link: PluginLink) => void;
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
  private readonly linkup: PluginLinkup;
  private onConnect: (() => void) | undefined;
  private readonly connectionWaiters = new Set<() => void>();
  // Each link's latest ANNOTATIONS_CHANGED, gone with the link, and who waits for the next.
  private readonly annotationLogs = new WeakMap<PluginLink, AnnotationCursor>();
  private readonly annotationLogWaiters = new Set<() => void>();
  private readonly listener: RelayListener;
  private readonly ledger: RunLedger;
  private readonly channel: ChannelServer;
  private readonly setup: LinkSetup;
  private readonly documents: LinkDocuments;
  private readonly events: PluginBridgeEvents;
  // What this server's links introduce themselves as, and what its calls ask to be allowed.
  private readonly project: string;
  private readonly openFilesLookup: OpenFilesLookup = {
    links: () => this.authenticatedLinks(),
    documentOf: (link) => this.documentOf(link),
    instanceOf: (link) => this.linkup.instanceOf(link),
    openInstances: async (link, signal) =>
      (await this.request(link, { type: "OPEN_INSTANCES" }, { signal })).openInstances,
  };

  private readonly routes: EventRoutes = {
    // Every other plugin instance of the same owner re-reads its storage: one file open in two
    // instances must honor a grant or revoke made in either.
    GRANT_CHANGED: (link, event) => {
      for (const other of this.authenticatedLinks())
        if (other !== link && other.owner?.figmaUserId === link.owner?.figmaUserId)
          this.request(other, {
            type: "GRANT_CHANGED_ELSEWHERE",
            project: event.project,
            documentId: event.documentId,
          }).catch(() => {});
      this.events.onGrantChanged?.(link, event.granted);
    },
    // A new stamp or new names: a call waiting on this link sees it on its next poll.
    DOCUMENT_REPORTED: (link, event) => this.documents.reported(link, event.document),
    WRITE_ACCESS_SIGN_IN: (link) => this.events.onWriteAccessSignIn?.(link),
    CHANNEL_REQUEST: (link, event) => this.channel.serve(link, event),
    RUN_STATUS: (link, event) => this.ledger.runStatus(link, event),
    // Run-scoped, so these settle here rather than through the correlated-reply path.
    CANCEL_RESULT: (link, { type: _, executionId, ...answer }) =>
      this.ledger.settleCancelAnswer(executionId, answer, link),
    WITHDRAW_RESULT: (link, { type: _, executionId, ...answer }) =>
      this.ledger.settleWithdrawAnswer(executionId, answer, link),
    ANNOTATIONS_CHANGED: (link, event) => {
      this.annotationLogs.set(link, event.cursor);
      for (const wake of this.annotationLogWaiters) wake();
      this.annotationLogWaiters.clear();
    },
  };

  // Everything injectable for the tests and the contract harness: `linkCredentials` isolates
  // persistence to a temp dir; `project` stands in for the cwd; the clocks let them pin timeout behaviour without waiting out the real deadlines; `trace`
  // lets a test read what the trace kept. Production takes the defaults, and index.ts registers the
  // production capability allowlist.
  constructor({
    linkCredentials = new LinkCredentialStore(),
    project = canonicalProjectPath(),
    framelinkOrigin = new URL(DEFAULT_FRAMELINK_API_URL).origin,
    nonRunRequestTimeoutMs = NON_RUN_REQUEST_TIMEOUT_MS,
    unauthenticatedLinkMs = UNAUTHENTICATED_LINK_MS,
    capabilities = new Map(),
    events = {},
    trace = new RequestTrace((event) => Logger.log("Bridge trace " + JSON.stringify(event))),
  }: {
    linkCredentials?: LinkCredentialStore;
    project?: string;
    framelinkOrigin?: string;
    nonRunRequestTimeoutMs?: number;
    unauthenticatedLinkMs?: number;
    capabilities?: ReadonlyMap<string, CapabilityHandler>;
    events?: PluginBridgeEvents;
    trace?: RequestTrace;
  } = {}) {
    this.events = events;
    this.project = project;
    this.linkup = new PluginLinkup();
    this.ledger = new RunLedger({
      nonRunRequestTimeoutMs,
      trace,
      disconnectedDurationMs: () => this.disconnectedDurationMs(),
    });
    this.setup = new LinkSetup({
      credentials: linkCredentials,
      unauthenticatedLinkMs,
      links: () => this.links,
      // Sound because the ledger resolves only what parseReply admitted for this payload's type.
      send: <T extends LinkSetupRequest>(link: PluginLink, payload: T) =>
        this.ledger.submit(link, payload) as Promise<ReplyFor<T["type"]>>,
      onAuthenticated: (link) => {
        this.documents.introduce(link);
        this.events.onLinkAuthenticated?.(link);
      },
    });
    this.documents = new LinkDocuments({
      send: (link, payload) => this.request(link, payload),
      onIntroduced: (link, reply) => this.linkup.introduced(link, reply.instance),
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
   * links still setting up are waited out rather than guessed about, until the call's `deadline`:
   * then they are judged as they stand.
   */
  async resolveLink(signal?: AbortSignal, deadline = Infinity): Promise<LinkResolution> {
    this.setup.rechallenge();
    for (;;) {
      const settling = [...this.links].filter(
        (link) => link.isOpen && isSettlingLinkStage(link.stage),
      );
      if (!settling.length || Date.now() >= deadline) break;
      const changed = Promise.race(settling.map((link) => link.stageChanged));
      if (!Number.isFinite(deadline)) {
        await waitForSignal(changed, signal);
        continue;
      }
      const timeUp = AbortSignal.timeout(Math.max(deadline - Date.now(), 0));
      await waitForSignal(changed, AbortSignal.any([...(signal ? [signal] : []), timeUp])).catch(
        (error: unknown) => {
          if (!timeUp.aborted || signal?.aborted) throw error;
        },
      );
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
   * The one document a call runs against, and the link to run it on — see call-target.ts. Prompts
   * in the plugin only for a call that named its document; submits nothing.
   */
  targetCall(request: CallTargetRequest, options: CallTargetOptions): Promise<CallTarget> {
    return targetPluginCall(
      {
        ...this.openFilesLookup,
        project: this.project,
        links: () => this.authenticatedLinks(),
        grantStatus: (link, ask, signal) => this.grantStatus(link, ask, signal),
        pauseForLinkup: (ms, signal) => this.linkup.pause(ms, signal),
        documentsSettled: (links) => this.documents.settled(links),
        closePrompt: (link, executionId) => {
          this.request(link, { type: "GRANT_PROMPT_CLOSED", executionId }).catch(() => {});
        },
        lookupSession: async (link, handle, signal) =>
          (await this.request(link, { type: "SESSION_LOOKUP", handle }, { signal })).held,
      },
      request,
      options,
    );
  }

  /**
   * Every file with the plugin open, linked or still linking, once each link's introduction has
   * answered. What a refusal and the reference show an agent to choose from (open-files.ts).
   */
  async openDocuments(signal: AbortSignal): Promise<OpenDocumentSnapshot> {
    await this.documents.settled(this.authenticatedLinks());
    return openDocumentSnapshot(this.openFilesLookup, signal);
  }

  /** Wait `ms`, or less: until the next plugin introduction or drop. */
  pauseForLinkup(ms: number, signal: AbortSignal): Promise<void> {
    return this.linkup.pause(ms, signal);
  }

  /** Where `link`'s annotation log last said it had moved to, if it has said. */
  annotationLogOf(link: PluginLink): AnnotationCursor | undefined {
    return this.annotationLogs.get(link);
  }

  /** Resolves at the next ANNOTATIONS_CHANGED from any link. */
  whenAnnotationLogMoves(signal: AbortSignal): Promise<void> {
    let wake!: () => void;
    const moved = new Promise<void>((resolve) => (wake = resolve));
    this.annotationLogWaiters.add(wake);
    const forget = () => this.annotationLogWaiters.delete(wake);
    signal.addEventListener("abort", forget, { once: true });
    return waitForSignal(moved, signal).finally(() => signal.removeEventListener("abort", forget));
  }

  /** Which file `link` is in, as far as this server knows. */
  documentOf(link: PluginLink): LinkDocument {
    return this.documents.documentOf(link);
  }

  /**
   * Ask a link's plugin whether this project holds a grant on `documentId`, for the call
   * `executionId`, prompting as `prompt` says.
   */
  async grantStatus(
    link: PluginLink,
    ask: GrantStatusRequest,
    signal?: AbortSignal,
  ): Promise<GrantState> {
    const reply = await this.request(link, { type: "GRANT_STATUS", ...ask }, { signal });
    return reply.state;
  }

  /**
   * Send a request that is no run on an authenticated link, under a fresh correlation id, and resolve
   * with its reply, admitted by the protocol's parser for that request type. An ERROR reply, or one
   * that isn't the shape its request is owed, rejects. A link that dropped or never authenticated is
   * refused before anything is sent.
   */
  request<T extends Exclude<LinkRequest, RunRequest>>(
    link: PluginLink,
    payload: T,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<ReplyFor<T["type"]>> {
    return this.submit(link, payload, { signal });
  }

  /**
   * Submit a run on an authenticated link under `executionId`, the one id its queueing, cancellation,
   * reverse calls and late events are matched by. Pinned to `link`: nothing another link sends can
   * settle it. Never resubmit an id the plugin admitted — a lost outcome is unknown, not retried.
   */
  submitRun<T extends RunRequest>(
    link: PluginLink,
    payload: T,
    executionId: ExecutionId,
    options: Omit<LedgerSubmitOptions, "id"> = {},
  ): Promise<ReplyFor<T["type"]>> {
    return this.submit(link, payload, { ...options, id: executionId });
  }

  /** What the server last knew of a run in flight, or null once it settled (or before it was sent). */
  runState(executionId: ExecutionId): RunState | null {
    return this.ledger.runState(executionId);
  }

  /**
   * Ask the plugin to drop a run that hasn't started. On `withdrawn` its submission rejects as
   * not-submitted; on any other answer it runs on.
   */
  withdrawRun(executionId: ExecutionId): Promise<WithdrawOutcome> {
    return this.ledger.withdrawRun(executionId);
  }

  /**
   * Cancel a run in flight, cooperatively: its submission rejects worded from the plugin's cancel
   * answer. False when it is not in flight.
   */
  cancelRun(executionId: ExecutionId): boolean {
    return this.ledger.cancelRun(executionId);
  }

  private submit<T extends LinkRequest>(
    link: PluginLink,
    payload: T,
    options: LedgerSubmitOptions,
  ): Promise<ReplyFor<T["type"]>> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    if (!this.isLive(link))
      return Promise.reject(
        new BridgeRequestError(
          pluginDisconnectedNotSubmittedText(this.disconnectedDurationMs()),
          "not-submitted",
        ),
      );
    // Sound because the ledger resolves only what parseReply admitted for this payload's type.
    return this.ledger.submit(link, payload, options) as Promise<ReplyFor<T["type"]>>;
  }

  private isLive(link: PluginLink): boolean {
    return this.links.has(link) && link.isOpen && link.isAuthenticated;
  }

  private drop(link: PluginLink): void {
    if (!this.links.delete(link)) return;
    this.linkup.dropped(link);
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
    this.ledger.settleReply(link, msg.id, msg);
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
