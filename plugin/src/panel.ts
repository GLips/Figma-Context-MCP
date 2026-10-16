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
 * so replies, sessions, cancellation and server calls all name the connection they belong to.
 */
export type ConnKey = number;

/** One row of the session list. Never the session token: a localhost bearer value, not for display. */
export interface PanelSession {
  key: ConnKey;
  identity: string | null;
  label: string;
  approved: boolean;
  active: boolean;
  writeAccess: WriteAccessNotice | null;
  // Whether the session's socket is open. A closed one is an away request: it asked, its call gave
  // up, and its socket went before anyone clicked Allow.
  connected: boolean;
  // The session's latest approval request: still waiting on a call, or expired with nothing waiting
  // to run. Null for an approved session or one that has never asked.
  request: "waiting" | "expired" | null;
  // The human rejected this connected session; its calls are refused until an Allow.
  rejected: boolean;
  // An away request the human already allowed; it applies when that session next connects.
  allowedWhileAway: boolean;
}

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
  sessions: PanelSession[];
  expanded: boolean;
  showOrientation: boolean;
  // Any remembered approval at all, connected or not: gates "Revoke all approvals".
  hasApprovals: boolean;
  approvalStorageError: string | null;
}

/** The panel's input to the host: the human's clicks, the iframe's measurements, the relay's signals. */
export type PanelControl =
  | { type: "UI_READY" }
  | { type: "UI_TOGGLE" }
  | { type: "UI_REVOKE_ALL" }
  | { type: "UI_HEIGHT"; height: number }
  // Only for a socket that actually opened, never for the empty block ports the relay also dials.
  | { type: "WS_CONNECTED"; connKey: ConnKey }
  | { type: "WS_CLOSED"; connKey: ConnKey }
  | { type: "UI_DECISION"; connKey: ConnKey; approve: boolean }
  | { type: "UI_SIGN_IN"; connKey: ConnKey }
  | { type: "UI_OPEN_SIGN_IN"; connKey: ConnKey }
  | { type: "UI_REVOKE"; connKey: ConnKey };

/** Relay → host. The frame is untrusted JSON until the host admits it (protocol.ts parseServerFrame). */
export type HostInbound =
  | { from: "server"; connKey: ConnKey; frame: unknown }
  | { from: "panel"; control: PanelControl };

/** Host → relay. */
export type HostOutbound =
  | { to: "server"; connKey: ConnKey; frame: PluginFrame }
  | { to: "panel"; render: PanelRender };
