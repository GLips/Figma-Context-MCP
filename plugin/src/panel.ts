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
 * A decision for the human in this panel:
 *   • allow — let a project edit this document. One per project, whichever of its calls asked; it
 *     stays after they stop waiting (`waitedOn` false), and Allow then lets the project's next call in.
 *     Clicks name `id`, the grant scope it saves, so they can't land on another project or stamp.
 *   • pick — whether this copy is the one a call means, where two open files carry one document id.
 *     That call's alone, and its click names the call and the document shown.
 */
export type PanelPrompt =
  | {
      kind: "allow";
      id: string;
      project: string;
      // The project's short name, as its grant row is labelled.
      label: string;
      // The newest asking call's own words: display text only, rendered as plain text.
      intent: string;
      waitedOn: boolean;
      // An Allow is being saved.
      allowing: boolean;
    }
  | { kind: "pick"; key: ConnKey; executionId: string; project: string; label: string; documentId: string; intent: string };

/**
 * Where one call in this file stands, as the activity feed shows it:
 *   • waiting — it waits on a prompt here. One that stopped waiting unanswered is not-run.
 *   • allowed / picked — the human answered its prompt here, and the call is on its way.
 *   • denied — the human denied it here; refused — the plugin refused it before anything ran.
 *   • queued, running — then done or failed by what its run reported, or cancelled.
 *   • withdrawn — its caller stopped waiting while it was queued, so it never ran.
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
  | "cancelled"
  | "withdrawn";

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
  // The iframe's document.visibilityState: whether this plugin's tab or window is showing.
  | { type: "UI_VISIBILITY"; visible: boolean }
  // Only for a socket that actually opened, never for the empty block ports the relay also dials.
  | { type: "WS_CONNECTED"; connKey: ConnKey }
  | { type: "WS_CLOSED"; connKey: ConnKey }
  // Allow saves the grant the prompt showed; Deny refuses every call waiting on it.
  | { type: "UI_DECISION"; promptId: string; approve: boolean }
  // Put away an Allow prompt no call waits on any more.
  | { type: "UI_DISMISS"; promptId: string }
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
