/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The real plugin, both halves, against a real server socket: the relay iframe (ui.ts) and the host
// (code.ts) are bundled from source and run in their own vm contexts, joined the way Figma joins them
// (an async postMessage each way). Only Figma itself is a stand-in: one page, a user, and storage.
// Shared by the loopback test and scripts/bridge-contract.mjs.
//
// The relay dials the production port block in order; the first port it dials is routed to
// `serverPort`, and every other port is a socket that never opens — an empty block port, as most are.
import vm from "node:vm";
import { buildSync } from "esbuild";
import { WebSocket } from "ws";
import type { HostInbound, HostOutbound, PanelControl, PanelRender } from "@framelink/plugin/panel";

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
  /** Figma's clientStorage. Share one Map between instances to model the same plugin reopened. */
  storage?: Map<string, unknown>;
  /** Hold each GET_VERSION this long before the host sees it: a handshake still in flight. */
  holdVersionMs?: number;
}

export interface LoopbackPlugin {
  /** Resolves once the relay has a socket open to the server. */
  opened(): Promise<void>;
  /** Click Allow on the connected, unapproved session; resolves once the token is handed over. */
  allow(): Promise<void>;
  /** Click the panel's sign-in button on the approved session. */
  signIn(): void;
  /** Click Revoke access on the approved session. */
  revoke(): void;
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
  serverPort: number,
  { storage = new Map(), holdVersionMs = 0 }: LoopbackPluginOptions = {},
): LoopbackPlugin {
  const sockets = new Set<WebSocket>();
  const toasts: string[] = [];
  let lastRender: PanelRender | null = null;
  let handedOver = 0;
  let closed = false;

  // ---- The relay iframe ----
  let routedPort: number | undefined;
  class RelaySocket {
    static OPEN = 1;
    readyState = 0;
    onopen = () => {};
    onclose = () => {};
    onmessage = (_event: { data: string }) => {};
    private readonly socket: WebSocket | null = null;
    constructor(url: string) {
      const port = Number(url.split(":").at(-1));
      routedPort ??= port;
      if (port !== routedPort || closed) return;
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
        if (holdVersionMs && JSON.parse(data.toString()).type === "GET_VERSION")
          setTimeout(deliver, holdVersionMs).unref();
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
    currentUser: { id: "loopback-user", name: "Loopback Human" },
    currentPage: page,
    root: { children: [page] },
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
    },
    ui: {
      resize() {},
      onmessage: (_inbound: HostInbound) => {},
      postMessage: (outbound: HostOutbound) => {
        if (outbound.to === "panel") lastRender = outbound.render;
        else if (outbound.frame.type === "SESSION_TOKEN") handedOver++;
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
  const session = (approved: boolean) =>
    lastRender?.sessions.filter((s) => s.connected && s.approved === approved).at(-1);
  return {
    async opened() {
      while (![...sockets].some((socket) => socket.readyState === WebSocket.OPEN)) await tick();
    },
    async allow() {
      while (!session(false)) await tick();
      const before = handedOver;
      click({ type: "UI_DECISION", approve: true, connKey: session(false)!.key });
      while (handedOver === before) await tick();
    },
    signIn() {
      click({ type: "UI_SIGN_IN", connKey: session(true)!.key });
    },
    revoke() {
      click({ type: "UI_REVOKE", connKey: session(true)!.key });
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
