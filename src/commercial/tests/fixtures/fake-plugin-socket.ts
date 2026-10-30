/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  mintDocumentId,
  type DocumentReport,
  type OpenInstance,
  type PluginOwner,
} from "@framelink/plugin/protocol";
import type { PluginBridge, PluginLink } from "~/commercial/plugin-bridge/bridge.js";
import {
  LinkCredentialStore,
  linkProof,
  type LinkCredential,
} from "~/commercial/plugin-bridge/link-credential.js";
import { TEST_DOCUMENT_REPORT, TEST_PLUGIN_OWNER } from "./write-access.js";

/**
 * An in-memory plugin socket, handed to `PluginBridge.accept` the way the listener hands it a real
 * one. `frames` records what the bridge sent; `receive` delivers a frame as the plugin would. It
 * answers the link-setup envelope itself: HELLO when `answersHello`, and AUTHENTICATE with a proof
 * when it holds `credential`, LINK_UNPAIRED otherwise. INTRODUCE is answered with its `document`,
 * and OPEN_INSTANCES with itself and `otherInstances` as the plugin instances open.
 */
export class FakePluginSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly frames: Array<Record<string, unknown>> = [];
  /** Sees every frame the bridge sends, after its JSON round trip — to relay it on to a plugin. */
  onFrame?: (frame: Record<string, unknown>) => void;
  /** The bridge's link for this socket, once connectFakePlugin has settled it. */
  link!: PluginLink;

  constructor(
    private readonly answersHello: boolean,
    public credential: LinkCredential | null,
    private readonly owner: PluginOwner | null = TEST_PLUGIN_OWNER,
    private readonly document: DocumentReport = TEST_DOCUMENT_REPORT,
    private readonly otherInstances: readonly OpenInstance[] = [],
    private readonly answersIntroduce = true,
    readonly instance = mintDocumentId(),
    private readonly grantState?: (prompt: unknown) => string,
  ) {
    super();
  }

  send(raw: string): void {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    this.frames.push(frame);
    this.onFrame?.(frame);
    if (this.answersHello && frame.type === "HELLO")
      this.receive({
        type: "HELLO_RESULT",
        id: frame.id,
        protocolVersion: PROTOCOL_VERSION,
        pluginVersion: "test",
      });
    if (frame.type === "AUTHENTICATE") {
      const { credential } = this;
      this.receive(
        credential && credential.id === frame.credentialId
          ? {
              type: "LINK_PROOF",
              id: frame.id,
              proof: linkProof(credential, String(frame.nonce)),
              owner: this.owner,
            }
          : { type: "LINK_UNPAIRED", id: frame.id },
      );
    }
    if (frame.type === "PAIRING_OFFER" || frame.type === "PAIRING_CLOSED")
      this.receive({ type: `${frame.type}_ACK`, id: frame.id });
    if (frame.type === "INTRODUCE" && this.answersIntroduce)
      this.receive({
        type: "INTRODUCED",
        id: frame.id,
        document: this.document,
        instance: this.instance,
      });
    if (frame.type === "OPEN_INSTANCES" && this.answersIntroduce)
      this.receive({
        type: "OPEN_INSTANCES_RESULT",
        id: frame.id,
        openInstances: [
          ...(this.document.kind === "identified"
            ? [
                openInstanceOf(this.document, this.instance, {
                  granted: this.grantState?.("none") === "granted",
                }),
              ]
            : []),
          ...this.otherInstances,
        ],
      });
    if (frame.type === "GRANT_STATUS" && this.grantState)
      this.receive({ type: "GRANT", id: frame.id, state: this.grantState(frame.prompt) });
    if (frame.type === "GRANT_PROMPT_CLOSED")
      this.receive({ type: "GRANT_PROMPT_CLOSED_ACK", id: frame.id });
    if (frame.type === "PAIR_CONFIRMED") {
      this.credential = { id: String(frame.credentialId), secret: String(frame.secret) };
      this.receive({ type: "CREDENTIAL_STORED", id: frame.id });
    }
  }

  receive(frame: Record<string, unknown>): void {
    this.receiveRaw(JSON.stringify(frame));
  }

  receiveRaw(raw: string): void {
    this.emit("message", Buffer.from(raw));
  }

  ping(): void {}

  terminate(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

/** What a plugin open in `document` says of itself in OPEN_INSTANCES, with `overrides` on top. */
export function openInstanceOf(
  document: Extract<DocumentReport, { kind: "identified" }>,
  instance: string,
  overrides: Partial<OpenInstance> = {},
): OpenInstance {
  return {
    instance,
    documentId: document.documentId,
    fileName: document.fileName,
    ...(document.fileKey ? { fileKey: document.fileKey } : {}),
    currentPage: "Page 1",
    pageCount: 1,
    selection: { count: 0, names: [] },
    active: false,
    granted: false,
    ...overrides,
  };
}

/**
 * Connect a fake plugin and wait out its link setup. By default it holds the credential of the
 * test's state dir, so it authenticates; `paired: false` leaves it unpaired, and
 * `answersHello: false` leaves it in `hello` — a socket that never proves which protocol it speaks.
 * `frames` starts empty after setup, so a test reads only what its own requests sent.
 */
export async function connectFakePlugin(
  bridge: PluginBridge,
  {
    answersHello = true,
    paired = true,
    owner = TEST_PLUGIN_OWNER,
    credentials = new LinkCredentialStore(),
    document = TEST_DOCUMENT_REPORT,
    otherInstances = [],
    answersIntroduce = true,
    instance,
    grantState,
  }: {
    answersHello?: boolean;
    paired?: boolean;
    owner?: PluginOwner | null;
    credentials?: LinkCredentialStore;
    /** What the plugin reports about the file it is open in. */
    document?: DocumentReport;
    /** Other plugin instances its storage says are open, which may never link. */
    otherInstances?: readonly OpenInstance[];
    /** False: a plugin whose main thread is blocked, so its introduction never answers. */
    answersIntroduce?: boolean;
    /** The plugin run's instance id, for another fake's `otherInstances` to name. */
    instance?: string;
    /**
     * How it answers GRANT_STATUS, by prompt, from its first poll on: a call may poll it before
     * connectFakePlugin returns.
     */
    grantState?: (prompt: unknown) => string;
  } = {},
): Promise<FakePluginSocket> {
  const socket = new FakePluginSocket(
    answersHello,
    paired ? credentials.readOrCreate() : null,
    owner,
    document,
    otherInstances,
    answersIntroduce,
    instance,
    grantState,
  );
  bridge.accept(socket as unknown as WebSocket);
  // Settled when it authenticated, or (unpaired) once its AUTHENTICATE was answered and handled.
  const settled = () =>
    paired
      ? (socket.link = bridge
          .authenticatedLinks()
          .find((link) => link.socket === (socket as never))!)
      : socket.frames.some((frame) => frame.type === "AUTHENTICATE");
  // Microtask turns, not timers: setup is promise chains only, and tests may be on fake timers.
  for (let i = 0; answersHello && !settled(); i++) {
    if (i > 500) throw new Error("the fake plugin's link setup never settled");
    await Promise.resolve();
  }
  for (let i = 0; i < 20; i++) await Promise.resolve();
  socket.frames.length = 0;
  return socket;
}
