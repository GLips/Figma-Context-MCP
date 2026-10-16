/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The postMessage contract between the plugin host (code.ts) and its relay iframe (ui.ts). Both are
// built from this file, so neither side reads the other's messages by convention. Types only: the
// host bundle and the iframe bundle each carry nothing of the other.
//
// Two envelopes each way, kept structurally apart. Into the host, a WS frame rides only as `frame`
// inside a "server" envelope, and the panel's clicks and the relay's own signals only as `control`
// inside a "panel" one — the iframe builds both itself and never puts server bytes in the second, so
// a local process that dials the relay can't speak as the human. Out of the host, a frame for a
// server names its socket generation beside it, never inside it, so the routing key can't reach a
// server.
import type { PluginFrame, WriteAccessNotice } from "./protocol.js";

/**
 * One socket generation: the relay numbers every socket it opens, from 1, and never reuses a number,
 * so replies, grant rows, cancellation and server calls all name the connection they belong to.
 */
export type ConnKey = number;

/**
 * One row of the grant list: a connected server, or a project granted this file whose server isn't
 * connected (`key` null). Revoking a row's grant affects every agent of that project.
 */
export interface PanelGrantRow {
  key: ConnKey | null;
  project: string;
  label: string;
  // The grant this row stands for, once the file is proven: what Revoke names.
  grant: { credentialId: string; project: string } | null;
  granted: boolean;
  active: boolean;
  writeAccess: WriteAccessNotice | null;
  connected: boolean;
  // What a call of this server is asking right now: to be granted this file, or for the human to
  // pick a file. Null once answered, or when its polls stopped.
  prompt: "grant" | "select" | null;
  // The human said no to this server; its calls are refused until an Allow.
  denied: boolean;
  // An Allow is being saved.
  allowing: boolean;
}

/** What the panel knows about the file this plugin is in. */
export type PanelDocument =
  | { kind: "proven"; fileName: string }
  // `asking`: a server wants a file picked and this one can't be until it is identified.
  | { kind: "unproven"; asking: boolean; pasted: { fileKey: string; refuted: boolean } | null };

/**
 * A socket from a server this installation isn't paired with. `code` is the pairing attempt it is
 * showing: the human confirms it with their agent, never here, so the row has no buttons.
 */
export interface PanelPairing {
  key: ConnKey;
  code: string | null;
}

/** Everything the panel paints, pushed whole on every change. */
export interface PanelRender {
  pairings: PanelPairing[];
  // Null while no server has authenticated: nothing has asked about this file yet.
  document: PanelDocument | null;
  grantRows: PanelGrantRow[];
  expanded: boolean;
  showOrientation: boolean;
  grantStorageError: string | null;
}

/** The panel's input to the host: the human's clicks, the iframe's measurements, the relay's signals. */
export type PanelControl =
  | { type: "UI_READY" }
  | { type: "UI_TOGGLE" }
  | { type: "UI_HEIGHT"; height: number }
  // Only for a socket that actually opened, never for the empty block ports the relay also dials.
  | { type: "WS_CONNECTED"; connKey: ConnKey }
  | { type: "WS_CLOSED"; connKey: ConnKey }
  // Allow grants the row's project this file (and, when it asked for a pick, picks it); Deny refuses.
  | { type: "UI_DECISION"; connKey: ConnKey; approve: boolean }
  | { type: "UI_SIGN_IN"; connKey: ConnKey }
  | { type: "UI_OPEN_SIGN_IN"; connKey: ConnKey }
  | { type: "UI_REVOKE"; credentialId: string; project: string }
  // What the human pasted as this file's link. Text, unparsed: the host reads it.
  | { type: "UI_PASTE_LINK"; text: string };

/** Relay → host. The frame is untrusted JSON until the host admits it (protocol.ts parseServerFrame). */
export type HostInbound =
  | { from: "server"; connKey: ConnKey; frame: unknown }
  | { from: "panel"; control: PanelControl };

/** Host → relay. */
export type HostOutbound =
  | { to: "server"; connKey: ConnKey; frame: PluginFrame }
  | { to: "panel"; render: PanelRender };
