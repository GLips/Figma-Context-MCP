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
  // The grant this row stands for, once the file is identified: what Revoke names.
  grant: { credentialId: string; project: string } | null;
  granted: boolean;
  active: boolean;
  writeAccess: WriteAccessNotice | null;
  connected: boolean;
}

/**
 * One call waiting on the human in this panel: `allow` to let its project edit this document, or
 * `pick` to choose this copy where two open files carry one document id. Clicks name the call and the
 * document shown, so they can't land on another call, or on a stamp the human never saw.
 */
export interface PanelPrompt {
  key: ConnKey;
  executionId: string;
  kind: "allow" | "pick";
  project: string;
  documentId: string;
  // What the call says it is for: display text only, rendered as plain text.
  intent: string;
  // An Allow is being saved.
  allowing: boolean;
}

/**
 * Where one call in this file stands, as the activity feed shows it:
 *   • waiting — its prompt is showing here. A prompt that lapsed or closed unanswered is not-run.
 *   • allowed / picked — the human answered its prompt here, and the call is on its way.
 *   • denied — the human denied it here; refused — the plugin refused it before anything ran.
 *   • queued, running — then done or failed by what its run reported, or cancelled.
 */
export type ActivityOutcome =
  | "waiting"
  | "not-run"
  | "allowed"
  | "picked"
  | "denied"
  | "refused"
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

/** One call in this file's activity feed, keyed by its execution id. */
export interface PanelActivity {
  executionId: string;
  intent: string;
  // The calling project's short name, as its grant row is labelled.
  label: string;
  // The agent session the run used: absent for screenshots and for calls refused before running.
  session: string | null;
  outcome: ActivityOutcome;
}

/** What the panel knows about the file this plugin is in. */
export type PanelDocument =
  | { kind: "identified"; fileName: string; documentId: string }
  | { kind: "unidentified"; problem: string };

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
  prompts: PanelPrompt[];
  // Newest first, and capped.
  activity: PanelActivity[];
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
  // Allow grants the call's project the document the prompt showed; Deny refuses that call.
  | { type: "UI_DECISION"; connKey: ConnKey; executionId: string; documentId: string; approve: boolean }
  // This copy is the one the call means: for that call only.
  | { type: "UI_PICK"; connKey: ConnKey; executionId: string; documentId: string }
  // Give this file a fresh stamp, apart from the copy it shares one with.
  | { type: "UI_RESTAMP" }
  | { type: "UI_SIGN_IN"; connKey: ConnKey }
  | { type: "UI_OPEN_SIGN_IN"; connKey: ConnKey }
  | { type: "UI_REVOKE"; credentialId: string; project: string };

/** Relay → host. The frame is untrusted JSON until the host admits it (protocol.ts parseServerFrame). */
export type HostInbound =
  | { from: "server"; connKey: ConnKey; frame: unknown }
  | { from: "panel"; control: PanelControl };

/** Host → relay. */
export type HostOutbound =
  | { to: "server"; connKey: ConnKey; frame: PluginFrame }
  | { to: "panel"; render: PanelRender };
