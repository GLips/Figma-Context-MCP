/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The plugin's only human surface: an always-visible status strip that expands into the session list.
// It paints what the approval gate says about each session, plus what is the panel's own to know:
// whether it is expanded, who holds the driving baton, and each row's write-access card.
import type { ApprovalRow } from "./session-approval.js";
import { toServer } from "./outbound.js";
import type { ConnKey, PanelRender, PanelSession } from "./panel.js";
import type { WriteAccessNotice } from "./protocol.js";

// The window is a fixed-width strip whose HEIGHT is whatever the iframe measures after each render
// (UI_HEIGHT) — so "collapsed" and "expanded" are CSS states over there, not two magic numbers here.
// The bounds exist only so a render bug can't produce a 0px or screen-filling window.
const UI_WIDTH = 320;
const UI_MIN_HEIGHT = 40;
const UI_MAX_HEIGHT = 560;

// First-run orientation: a one-time explainer the FIRST time the list is ever expanded. Read once at
// startup into a sync flag so expanding stays synchronous; an expand that beats the read shows it
// once more — harmless, so nothing waits for it.
const ORIENTATION_STORAGE_KEY = "code-mode:has-seen-orientation";

/** What the panel reads from the approval gate. */
export interface SessionPanelSource {
  approvalRows(now: number): ApprovalRow[];
  nextRequestLapse(now: number): number | null;
  /** Any remembered approval at all, connected or not: gates "Revoke all approvals". */
  hasApprovals(): boolean;
  readonly storageError: string | null;
  isConnected(key: ConnKey): boolean;
  isApproved(key: ConnKey): boolean;
  identityOf(key: ConnKey): string | null;
  framelinkOriginOf(key: ConnKey): string | null;
}

/**
 * The short, glanceable name for a session: the last segment of its identity (a project path). The
 * expanded row still shows the FULL identity, which is what the human actually approves.
 */
function sessionLabel(identity: string | null): string {
  if (identity === null) return "A session";
  const segments = identity.split("/").filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : identity;
}

// The scheme://host[:port] of an http(s) URL, lowercased, or null. Hand-rolled: the plugin sandbox
// has no URL class.
function httpOriginOf(url: string): string | null {
  const match = /^(https?:\/\/[^/?#\\@]+)(?:[/?#]|$)/i.exec(url);
  return match ? match[1].toLowerCase() : null;
}

export function createSessionPanel(source: SessionPanelSource) {
  // It starts VISIBLE and is never hidden. A running plugin's only summonable surface is its own
  // iframe — a menu command re-RUNS the plugin, tearing down the relay and every live connection —
  // so a hidden window would leave the human no way to check a session or reach Revoke. The iframe
  // is also the network transport (the only context with WS access).
  figma.showUI(__html__, { visible: true, width: UI_WIDTH, height: UI_MIN_HEIGHT, themeColors: true, title: "Framelink" });

  // Collapsed is the resting state. It expands when the human asks or when a session needs a
  // decision, which is the ONLY moment the plugin interrupts anyone.
  let expanded = false;
  let hasSeenOrientation = false;
  void figma.clientStorage.getAsync(ORIENTATION_STORAGE_KEY).then((seen) => {
    hasSeenOrientation = seen === true;
  });

  // Who holds the driving baton — the approved session whose write ran most recently. A LABEL for the
  // human ("● Driving this file"), not a gate: every write still passes the consent gate first, so it
  // is deliberately not cleared when the driver's socket drops.
  let activeKey: ConnKey | null = null;

  // The server's latest word on write access, per row; and the rows whose human asked to sign in —
  // the browser only ever opens because the human asked, never because a server pushed a URL.
  const writeAccess = new Map<ConnKey, WriteAccessNotice>();
  const signInRequested = new Set<ConnKey>();

  // One timer, re-armed for the soonest waiting request to lapse, so its row turns to "expired" when
  // the polls stop rather than at the next unrelated render.
  let expiryRender: ReturnType<typeof setTimeout> | undefined;

  function scheduleExpiryRender(now: number): void {
    if (expiryRender !== undefined) clearTimeout(expiryRender);
    expiryRender = undefined;
    const lapse = source.nextRequestLapse(now);
    if (lapse !== null) expiryRender = setTimeout(() => render(), lapse - now);
  }

  function sessions(now: number): PanelSession[] {
    return source.approvalRows(now).map((row) => ({
      ...row,
      label: sessionLabel(row.identity),
      active: row.connected && row.key === activeKey,
      writeAccess: row.connected ? (writeAccess.get(row.key) ?? null) : null,
    }));
  }

  /**
   * Push the current state to the strip — the single render path. The iframe re-measures itself after
   * painting and reports its height back (UI_HEIGHT), which is what resizes the window.
   */
  function render(showOrientation = false): void {
    const now = Date.now();
    const update: PanelRender = {
      sessions: sessions(now),
      expanded,
      showOrientation,
      hasApprovals: source.hasApprovals(),
      approvalStorageError: source.storageError,
    };
    figma.ui.postMessage({ to: "panel", render: update });
    scheduleExpiryRender(now);
  }

  /** Whether to show first-run orientation THIS expand — true once ever, persisted fire-and-forget. */
  function consumeFirstRunOrientation(): boolean {
    if (hasSeenOrientation) return false;
    hasSeenOrientation = true;
    void figma.clientStorage.setAsync(ORIENTATION_STORAGE_KEY, true);
    return true;
  }

  /** Expand or collapse, then paint. Idempotent, so a write blocked after a collapse re-opens the list. */
  function setExpanded(next: boolean): void {
    expanded = next;
    render(next ? consumeFirstRunOrientation() : false);
  }

  /** Open the sign-in page for this row's pending code — approved rows on the announced origin only. */
  function openSignIn(key: ConnKey): void {
    const notice = writeAccess.get(key);
    if (!source.isApproved(key) || notice?.kind !== "sign-in-pending") return;
    const origin = httpOriginOf(notice.verificationUri);
    if (origin === null || origin !== source.framelinkOriginOf(key)) return;
    figma.openExternal(notice.verificationUri);
  }

  return {
    render,
    setExpanded,
    /** Paint, optionally moving the list to `expandTo`. */
    show(expandTo?: boolean): void {
      if (expandTo === undefined) render();
      else setExpanded(expandTo);
    },
    toggle: () => setExpanded(!expanded),

    /**
     * Resize to the iframe's own measurement, clamped, outside the current handler turn. The
     * setTimeout is one turn of separation: a resize called synchronously inside an in-flight
     * figma_execute_code run once coincided with that request losing its reply. Cheap insurance.
     */
    resize(height: number): void {
      const clamped = Math.max(UI_MIN_HEIGHT, Math.min(UI_MAX_HEIGHT, Math.round(height)));
      setTimeout(() => figma.ui.resize(UI_WIDTH, clamped), 0);
    },

    /**
     * Hand the driving baton to an approved session, on its own write. A takeover is worth a toast,
     * but ONLY when a different live session was driving.
     */
    takeBaton(key: ConnKey): void {
      if (key === activeKey) return;
      const displaced = activeKey !== null && source.isConnected(activeKey);
      activeKey = key;
      if (displaced && source.isConnected(key))
        figma.notify(`${sessionLabel(source.identityOf(key))} is now driving this file.`, { timeout: 4000 });
      render();
    },

    /** A revoke ends driving: one session's, or (no key) everyone's. */
    dropBaton(key?: ConnKey): void {
      if (key === undefined || activeKey === key) activeKey = null;
    },

    /** The server's word on this row's write access; a sign-in code the human asked for opens. */
    noteWriteAccess(key: ConnKey, notice: WriteAccessNotice): void {
      if (!source.isConnected(key)) return;
      writeAccess.set(key, notice);
      if (notice.kind === "sign-in-pending" && signInRequested.delete(key)) openSignIn(key);
      setExpanded(true);
    },

    /** The human asked to sign in from this row; the server answers with a sign-in code. */
    requestSignIn(key: ConnKey): void {
      if (!source.isConnected(key) || !source.isApproved(key)) return;
      signInRequested.add(key);
      toServer(key, { type: "WRITE_ACCESS_SIGN_IN" });
    },

    openSignIn,

    /** The row's socket closed: its card and any sign-in it asked for go with it. */
    forget(key: ConnKey): void {
      writeAccess.delete(key);
      signInRequested.delete(key);
    },
  };
}
