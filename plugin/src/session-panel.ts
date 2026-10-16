/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The plugin's only human surface: an always-visible status strip that expands into the session list.
// It paints what link authentication says about unpaired sockets, what document identity says about
// this file, and what the grant gate says about each server, plus what is the panel's own to know:
// whether it is expanded, who holds the driving baton, and each row's write-access card.
import type { GrantRow } from "./grant-gate.js";
import { toServer } from "./outbound.js";
import type { ConnKey, PanelDocument, PanelPairing, PanelRender, PanelSession } from "./panel.js";
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

/** What the panel reads from the grant gate, link authentication and document identity. */
export interface SessionPanelSource {
  rows(now: number): GrantRow[];
  nextPromptLapse(now: number): number | null;
  document(now: number): PanelDocument | null;
  pairings(): PanelPairing[];
  readonly storageError: string | null;
  isConnected(key: ConnKey): boolean;
  isGranted(key: ConnKey): boolean;
  projectOf(key: ConnKey): string | null;
  framelinkOriginOf(key: ConnKey): string | null;
}

/**
 * The short, glanceable name for a server: the last segment of its project path. The expanded row
 * still shows the FULL path, which is what the human actually grants.
 */
function sessionLabel(project: string | null): string {
  if (project === null) return "A session";
  const segments = project.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : project;
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

  // Collapsed is the resting state. It expands when the human asks or when a server needs a
  // decision, which is the ONLY moment the plugin interrupts anyone.
  let expanded = false;
  let hasSeenOrientation = false;
  void figma.clientStorage.getAsync(ORIENTATION_STORAGE_KEY).then((seen) => {
    hasSeenOrientation = seen === true;
  });

  // Who holds the driving baton — the granted server whose run was admitted most recently. A LABEL
  // for the human ("● Driving this file"), not a gate: every run still passes the grant gate first,
  // so it is deliberately not cleared when the driver's socket drops.
  let activeKey: ConnKey | null = null;

  // The server's latest word on write access, per row; and the rows whose human asked to sign in —
  // the browser only ever opens because the human asked, never because a server pushed a URL.
  const writeAccess = new Map<ConnKey, WriteAccessNotice>();
  const signInRequested = new Set<ConnKey>();

  // One timer, re-armed for the soonest live prompt to lapse, so its row stops asking when the
  // polls stop rather than at the next unrelated render.
  let expiryRender: ReturnType<typeof setTimeout> | undefined;

  function scheduleExpiryRender(now: number): void {
    if (expiryRender !== undefined) clearTimeout(expiryRender);
    expiryRender = undefined;
    const lapse = source.nextPromptLapse(now);
    if (lapse !== null) expiryRender = setTimeout(() => render(), lapse - now);
  }

  function sessions(now: number): PanelSession[] {
    return source.rows(now).map((row) => ({
      ...row,
      label: sessionLabel(row.project),
      active: row.key !== null && row.key === activeKey,
      writeAccess: row.key !== null ? (writeAccess.get(row.key) ?? null) : null,
    }));
  }

  /**
   * Push the current state to the strip — the single render path. The iframe re-measures itself after
   * painting and reports its height back (UI_HEIGHT), which is what resizes the window.
   */
  function render(showOrientation = false): void {
    const now = Date.now();
    const update: PanelRender = {
      pairings: source.pairings(),
      document: source.document(now),
      sessions: sessions(now),
      expanded,
      showOrientation,
      grantStorageError: source.storageError,
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

  /** Open the sign-in page for this row's pending code — granted rows on the announced origin only. */
  function openSignIn(key: ConnKey): void {
    const notice = writeAccess.get(key);
    if (!source.isGranted(key) || notice?.kind !== "sign-in-pending") return;
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
     * Hand the driving baton to a granted server, on its own admitted run. A takeover is worth a
     * toast, but ONLY when a different live server was driving.
     */
    takeBaton(key: ConnKey): void {
      if (key === activeKey) return;
      const displaced = activeKey !== null && source.isConnected(activeKey);
      activeKey = key;
      if (displaced && source.isConnected(key))
        figma.notify(`${sessionLabel(source.projectOf(key))} is now driving this file.`, { timeout: 4000 });
      render();
    },

    /** A revoke or a close ends driving. */
    dropBaton(key: ConnKey): void {
      if (activeKey === key) activeKey = null;
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
      if (!source.isConnected(key) || !source.isGranted(key)) return;
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
