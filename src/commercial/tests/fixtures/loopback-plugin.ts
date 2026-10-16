/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The real plugin, both halves, against a real server socket: the relay iframe (ui.ts) and the host
// (code.ts) are bundled from source and run in their own vm contexts, joined the way Figma joins them
// (an async postMessage each way). Only Figma itself is a stand-in: one page, a user, storage, and
// the file the plugin is open in, whose root plugin data holds the stamp the plugin writes — so a
// duplicated file carries its original's stamp, as in Figma. Shared by the loopback test and
// scripts/bridge-contract.mjs.
//
// The relay dials the production port block in order; the first ports it dials are routed to
// `serverPorts`, one each, and every other port is a socket that never opens — an empty block port,
// as most are.
import vm from "node:vm";
import { buildSync } from "esbuild";
import { WebSocket } from "ws";
import type {
  HostInbound,
  HostOutbound,
  PanelControl,
  PanelPrompt,
  PanelRender,
  PanelGrantRow,
} from "@framelink/plugin/panel";

/** One Figma file: its name, its root's private plugin data, and its key where the build exposes one. */
export interface LoopbackFile {
  name: string;
  /** `figma.fileKey`: only private and development builds get one. */
  key: string | null;
  pluginData: Map<string, string>;
  /** A file the user may only view: Figma refuses every plugin data write. */
  readOnly: boolean;
}

/** The Figma files plugins can be open in. */
export class LoopbackFigma {
  file(
    name: string,
    { key = null, readOnly = false }: { key?: string | null; readOnly?: boolean } = {},
  ): LoopbackFile {
    return { name, key, pluginData: new Map(), readOnly };
  }

  /** Figma's Duplicate: a new file (and key), carrying everything in the root — the stamp too. */
  duplicate(original: LoopbackFile, key: string | null = null): LoopbackFile {
    const copy = this.file(`${original.name} (Copy)`, { key });
    for (const [entry, value] of original.pluginData) copy.pluginData.set(entry, value);
    return copy;
  }
}

// The plugin's stamp key (document-identity.ts). Read here only to tell a test which id it got.
const DOCUMENT_ID_KEY = "framelink-document-id";

const bundle = (entry: string) =>
  buildSync({
    entryPoints: [new URL(`../../../../plugin/src/${entry}`, import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "iife",
    logLevel: "silent",
  }).outputFiles[0].text;

const deferred = (callback: () => void) => setImmediate(callback);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10).unref());

export interface LoopbackPluginOptions {
  /**
   * Figma's clientStorage. Share one Map between instances to model the same plugin reopened, or
   * open in a second file: both see what the other stored, including its pairing.
   */
  storage?: Map<string, unknown>;
  /** Hold each HELLO this long before the host sees it: link setup still in flight. */
  holdHelloMs?: number;
  /** The file this plugin is open in. Two plugins given one file are two instances in it. */
  file?: LoopbackFile;
  /** The Figma user signed in; null for none. */
  user?: { id: string; name: string } | null;
}

export interface LoopbackPlugin {
  /** Resolves once the relay has a socket open to the server. */
  opened(): Promise<void>;
  /** The pairing code the panel shows, once it shows one. */
  pairingCode(): Promise<string>;
  /** Whether the panel shows any pairing code right now. */
  showsPairingCode(): boolean;
  /** The file this plugin is open in. */
  file: LoopbackFile;
  /** The stamp in this plugin's file now, or null before the plugin wrote one. */
  documentId(): string | null;
  /** The panel's rows now. */
  grantRows(): PanelGrantRow[];
  /** The calls asking the human now. */
  prompts(): PanelPrompt[];
  /** Whether any call is asking the human now. */
  isPrompting(): boolean;
  /**
   * Click Allow on the first Allow prompt (for `executionId`, when given), waiting for one; resolves
   * once the grant is saved and announced.
   */
  allow(executionId?: string): Promise<void>;
  /** Click Deny on the first Allow prompt (for `executionId`, when given), waiting for one. */
  deny(executionId?: string): Promise<void>;
  /** Click "Use this one" on the first pick prompt, waiting for one. */
  pick(): Promise<void>;
  /** Click "Give this copy its own identity"; resolves once the file holds a new stamp. */
  restamp(): Promise<void>;
  /** Click the panel's sign-in button on the granted session. */
  signIn(): void;
  /** Click Revoke on the grant of `project` (the first granted row by default). */
  revoke(project?: string): void;
  /** Figma's toasts, in order. */
  toasts: string[];
  /** Deliver the node changes Figma has noticed since the last call. */
  deliverChanges(): void;
  /** Drop the socket the way a server restart does; the relay redials on its own cadence. */
  drop(): void;
  /** Close the plugin for good: no socket stays open, and the relay stops redialing. */
  close(): void;
}

export function startLoopbackPlugin(
  serverPorts: number | readonly number[],
  {
    storage = new Map(),
    holdHelloMs = 0,
    file = new LoopbackFigma().file("Loopback file"),
    user = { id: "loopback-user", name: "Loopback Human" },
  }: LoopbackPluginOptions = {},
): LoopbackPlugin {
  const sockets = new Set<WebSocket>();
  const toasts: string[] = [];
  let lastRender: PanelRender | null = null;
  let grantsAnnounced = 0;
  let closed = false;

  // ---- The relay iframe ----
  const unrouted = [serverPorts].flat();
  const routes = new Map<number, number>();
  class RelaySocket {
    static OPEN = 1;
    readyState = 0;
    onopen = () => {};
    onclose = () => {};
    onmessage = (_event: { data: string }) => {};
    private readonly socket: WebSocket | null = null;
    constructor(url: string) {
      const port = Number(url.split(":").at(-1));
      if (!routes.has(port) && unrouted.length) routes.set(port, unrouted.shift()!);
      const serverPort = routes.get(port);
      if (serverPort === undefined || closed) return;
      const socket = new WebSocket(`ws://127.0.0.1:${serverPort}`, { origin: "null" });
      this.socket = socket;
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("open", () => {
        this.readyState = 1;
        this.onopen();
      });
      socket.on("message", (data) => {
        const deliver = () => this.onmessage({ data: data.toString() });
        if (holdHelloMs && JSON.parse(data.toString()).type === "HELLO")
          setTimeout(deliver, holdHelloMs).unref();
        else deliver();
      });
      socket.on("close", () => {
        sockets.delete(socket);
        this.readyState = 3;
        this.onclose();
      });
    }
    send(raw: string) {
      this.socket?.send(raw);
    }
  }
  const element = (): Record<string, unknown> => ({
    setAttribute() {},
    appendChild() {},
    style: {},
  });
  const relayWindow: { onmessage?: (event: { data: { pluginMessage: HostOutbound } }) => void } =
    {};
  const relay = vm.createContext({
    WebSocket: RelaySocket,
    parent: {
      postMessage: (message: { pluginMessage: HostInbound }) =>
        deferred(() => figma.ui.onmessage(message.pluginMessage)),
    },
    window: relayWindow,
    document: { getElementById: element, createElement: element },
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms).unref(),
    requestAnimationFrame() {},
    console,
  });

  // ---- Figma, as the host sees it ----
  const nodeChangeListeners = new Set<(event: unknown) => void>();
  const noticed: unknown[] = [];
  const page = {
    id: "0:1",
    name: "Page 1",
    type: "PAGE",
    children: [],
    on: (_type: string, listener: (event: unknown) => void) => nodeChangeListeners.add(listener),
    off: (_type: string, listener: (event: unknown) => void) =>
      nodeChangeListeners.delete(listener),
  };
  const figma = {
    showUI() {},
    notify: (message: string) => toasts.push(message),
    currentUser: user,
    currentPage: page,
    get fileKey() {
      return file.key ?? undefined;
    },
    root: {
      get name() {
        return file.name;
      },
      children: [page],
      getPluginData: (key: string) => file.pluginData.get(key) ?? "",
      setPluginData: (key: string, value: string) => {
        if (file.readOnly) throw new Error("Cannot write to a read-only file");
        if (value) file.pluginData.set(key, value);
        else file.pluginData.delete(key);
      },
    },
    on() {},
    off() {},
    openExternal() {},
    createRectangle() {
      noticed.push({ type: "CREATE", id: "9:9", origin: "LOCAL" });
      return { id: "9:9", type: "RECTANGLE" };
    },
    clientStorage: {
      getAsync: async (key: string) => storage.get(key),
      setAsync: async (key: string, value: unknown) => void storage.set(key, value),
      deleteAsync: async (key: string) => void storage.delete(key),
      keysAsync: async () => [...storage.keys()],
    },
    ui: {
      resize() {},
      onmessage: (_inbound: HostInbound) => {},
      postMessage: (outbound: HostOutbound) => {
        if (outbound.to === "panel") lastRender = outbound.render;
        else if (outbound.frame.type === "GRANT_CHANGED" && outbound.frame.granted)
          grantsAnnounced++;
        deferred(() => relayWindow.onmessage?.({ data: { pluginMessage: outbound } }));
      },
    },
  };
  vm.runInContext(
    bundle("code.ts"),
    vm.createContext({
      figma,
      __html__: "",
      console,
      setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms).unref(),
      clearTimeout,
    }),
  );
  vm.runInContext(bundle("ui.ts"), relay);

  // What the panel's buttons post (ui.ts): a "panel" envelope, which only the relay itself builds.
  const click = (control: PanelControl) => figma.ui.onmessage({ from: "panel", control });
  const grantRows = () => lastRender?.grantRows ?? [];
  const prompts = () => lastRender?.prompts ?? [];
  const asking = (kind: PanelPrompt["kind"], executionId?: string) =>
    prompts().find(
      (prompt) =>
        prompt.kind === kind &&
        !prompt.allowing &&
        (executionId === undefined || prompt.executionId === executionId),
    );
  const documentId = () => file.pluginData.get(DOCUMENT_ID_KEY) ?? null;
  const granted = (project?: string) =>
    grantRows().find((s) => s.granted && (project === undefined || s.project === project));
  const shownCode = () => lastRender?.pairings.find((pairing) => pairing.code)?.code ?? null;
  return {
    async opened() {
      while (![...sockets].some((socket) => socket.readyState === WebSocket.OPEN)) await tick();
    },
    async pairingCode() {
      while (!shownCode()) await tick();
      return shownCode()!;
    },
    showsPairingCode: () => shownCode() !== null,
    file,
    documentId,
    grantRows,
    prompts,
    isPrompting: () => prompts().some((prompt) => !prompt.allowing),
    async allow(executionId) {
      while (!asking("allow", executionId)) await tick();
      const { key, documentId: shown, executionId: call } = asking("allow", executionId)!;
      const before = grantsAnnounced;
      click({
        type: "UI_DECISION",
        approve: true,
        connKey: key,
        executionId: call,
        documentId: shown,
      });
      while (grantsAnnounced === before) await tick();
    },
    async deny(executionId) {
      while (!asking("allow", executionId)) await tick();
      const { key, documentId: shown, executionId: call } = asking("allow", executionId)!;
      click({
        type: "UI_DECISION",
        approve: false,
        connKey: key,
        executionId: call,
        documentId: shown,
      });
    },
    async pick() {
      while (!asking("pick")) await tick();
      const { key, documentId: shown, executionId } = asking("pick")!;
      click({ type: "UI_PICK", connKey: key, executionId, documentId: shown });
    },
    async restamp() {
      const before = documentId();
      click({ type: "UI_RESTAMP" });
      while (documentId() === before) await tick();
    },
    signIn() {
      click({ type: "UI_SIGN_IN", connKey: granted()!.key! });
    },
    revoke(project) {
      const { grant } = granted(project)!;
      click({ type: "UI_REVOKE", ...grant! });
    },
    toasts,
    deliverChanges() {
      const nodeChanges = noticed.splice(0);
      if (nodeChanges.length)
        for (const listener of [...nodeChangeListeners]) listener({ nodeChanges });
    },
    drop() {
      for (const socket of sockets) socket.terminate();
    },
    close() {
      closed = true;
      for (const socket of sockets) socket.terminate();
    },
  };
}
