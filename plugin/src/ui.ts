/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The plugin's ONLY network context (the host, code.ts, has no WS access), so this iframe relays
// server↔host traffic without reading it. It is ALSO the plugin's only human surface: an always-
// visible status strip that expands into the session list. The host drives it with one render
// envelope and owns every decision; this file only reports clicks and its own measured height.
// Messages both ways are typed in panel.ts. build.mjs inlines the bundle into dist/ui.html.
import { WS_PORT_BLOCK, type WriteAccessNotice } from "./protocol.js";
import type {
  ConnKey,
  HostInbound,
  HostOutbound,
  PanelControl,
  PanelPairing,
  PanelRender,
  PanelSession,
} from "./panel.js";

// Discovery is keyed by port; host traffic by socket generation, which never reuses a port's number.
const sockets = new Map<number, WebSocket>();
const routes = new Map<ConnKey, WebSocket>();
let nextConnectionKey = 0;

// Reconnect cadence, per port. A port that has NEVER opened is almost certainly empty, so its retries
// back off 1s → 15s. This is purely to tame console noise: every doomed connect emits a browser-level
// "WebSocket connection to … failed" line that JS cannot catch or mute. A port that has opened (a
// real session) stays on the fast cadence so a dropped/restarted server reappears promptly.
const BASE_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 15000;
const reconnectDelays = new Map<number, number>();
// When each port last had a socket open, and how long after that it keeps the fast cadence through
// failed retries. A server restart's first retry lands in the rebuild gap and never opens; without
// the grace the doubling pushes a port we KNOW hosts a server onto the slow cadence at the one moment
// it must be rediscovered. A grace, not a permanent exemption: closed-for-good servers accumulate
// over a long session, and polling each of them every second recreates the console storm.
const FAST_RECONNECT_GRACE_MS = 30000;
const lastOpenAt = new Map<number, number>();

function toHost(inbound: HostInbound): void {
  parent.postMessage({ pluginMessage: inbound }, "*");
}

// Everything this document itself says to the host goes in a "panel" envelope, and ONLY from here.
// A server frame travels in its own "server" envelope (ws.onmessage), so a local process that dials
// the relay can never put words in the human's mouth (an Allow, a sign-in) whatever it sends.
function toSandbox(control: PanelControl): void {
  toHost({ from: "panel", control });
}

// ONE persistent connection per block port: each server binds one, so the scan discovers every live
// session, and onclose is the disconnect signal. `localhost`, never 127.0.0.1: Figma's manifest
// validator rejects IP literals, and the allowlist host must match the host dialed. A refused `::1`
// connect returns instantly, so Chromium falls back to the server's IPv4 loopback unnoticed.
//
// Called only at startup and from onclose, which has already dropped this port's socket.
function connect(port: number): void {
  const ws = new WebSocket("ws://localhost:" + port);
  const connKey = ++nextConnectionKey;
  sockets.set(port, ws);
  // Most block ports have no server, so their connect fails and fires onclose without ever opening.
  // The host hears only about sockets that opened — a signal per failed retry would storm the panel.
  let opened = false;
  ws.onopen = () => {
    if (sockets.get(port) !== ws) return;
    routes.set(connKey, ws);
    opened = true;
    lastOpenAt.set(port, Date.now());
    reconnectDelays.set(port, BASE_RECONNECT_MS);
    // A FRESH connection: the host starts it unapproved, so a different local server that grabbed a
    // freed port can't ride the previous socket's approval. onopen fires before any onmessage on this
    // socket, so the reset lands before the new server's first frame.
    toSandbox({ type: "WS_CONNECTED", connKey });
  };
  ws.onmessage = (event: MessageEvent<string>) => {
    if (sockets.get(port) !== ws) return;
    toHost({ from: "server", connKey, frame: JSON.parse(event.data) });
  };
  ws.onclose = () => {
    routes.delete(connKey);
    if (sockets.get(port) !== ws) return;
    sockets.delete(port);
    if (opened) toSandbox({ type: "WS_CLOSED", connKey });
    else if (Date.now() - (lastOpenAt.get(port) ?? 0) > FAST_RECONNECT_GRACE_MS) {
      const previous = reconnectDelays.get(port) ?? BASE_RECONNECT_MS;
      reconnectDelays.set(port, Math.min(previous * 2, MAX_RECONNECT_MS));
    }
    // Auto-reconnect either way: the plugin outlives any single server run, and an empty port keeps
    // its slot warm for a server that may yet bind it.
    setTimeout(() => connect(port), reconnectDelays.get(port) ?? BASE_RECONNECT_MS);
  };
}

window.onmessage = (event: MessageEvent<{ pluginMessage?: HostOutbound }>) => {
  const outbound = event.data.pluginMessage;
  if (!outbound) return;
  if (outbound.to === "panel") {
    render(outbound.render);
    return;
  }
  // Only on the socket generation the frame belongs to: a reply for a closed socket is dropped, never
  // sent on whatever replaced it.
  const ws = routes.get(outbound.connKey);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(outbound.frame));
};

// Allow / Deny → the host (sole arbiter), tagged with the row's connection. The button carries NO
// approval logic: it reports the human's choice; the host mints the token.
function decide(approve: boolean, connKey: ConnKey): void {
  toSandbox({ type: "UI_DECISION", approve, connKey });
}

byId("strip").onclick = () => toSandbox({ type: "UI_TOGGLE" });

// The whole surface from one render: the always-on strip, plus — when expanded — the session list.
// Built with textContent, never innerHTML, so a project path can't inject markup.
function render(state: PanelRender): void {
  renderStrip(state.pairings, state.sessions, state.expanded);
  const detail = byId("detail");
  detail.textContent = "";
  detail.style.display = state.expanded ? "flex" : "none";
  if (state.expanded) {
    if (state.showOrientation) detail.appendChild(orientationBanner());
    if (state.approvalStorageError) detail.appendChild(el("div", "orientation", state.approvalStorageError));
    if (!state.sessions.length && !state.pairings.length) detail.appendChild(emptyState());
    for (const pairing of state.pairings) detail.appendChild(pairingCard(pairing));
    for (const session of state.sessions) detail.appendChild(sessionCard(session));
    if (state.hasApprovals) detail.appendChild(revokeAllFooter());
  }
  reportHeight();
}

// One glanceable line, in priority order: a code to confirm > a decision you owe > who is driving >
// who is ready.
function renderStrip(pairings: PanelPairing[], sessions: PanelSession[], expanded: boolean): void {
  let wants = 0;
  let expired = 0;
  let approved = 0;
  let active: PanelSession | null = null;
  let writesSpent = false;
  for (const s of sessions) {
    if (s.approved) approved++;
    else if (s.rejected) {
      // Already answered: a rejected session owes the human nothing.
    } else if (s.request === "expired") {
      if (!s.allowedWhileAway) expired++;
    } else wants++;
    if (s.active) active = s;
    if (s.writeAccess?.kind === "allowance-exhausted") writesSpent = true;
  }

  const offered = pairings.filter((p) => p.code !== null);
  let text: string;
  let tone: string;
  if (offered.length) {
    text = offered.length === 1 ? "Pairing code " + offered[0].code : offered.length + " pairing codes to check";
    tone = "wants";
  } else if (wants) {
    text = wants === 1 ? "A session wants to connect" : wants + " sessions want to connect";
    tone = "wants";
  } else if (writesSpent) {
    // Writes are being refused until the human acts, so it outranks who is driving.
    text = "Free writes used up — sign in to keep writing";
    tone = "wants";
  } else if (active) {
    text = active.label + " — driving";
    tone = "live";
  } else if (approved === 1) {
    text = (sessions.find((s) => s.approved)?.label ?? "A session") + " — ready";
    tone = "ready";
  } else if (approved) {
    text = approved + " sessions ready";
    tone = "ready";
  } else if (expired) {
    text = expired === 1 ? "An approval request expired" : expired + " approval requests expired";
    tone = "";
  } else {
    text = "Waiting for a session…";
    tone = "";
  }

  byId("dot").className = tone;
  byId("status").textContent = text;
  byId("chevron").className = expanded ? "up" : "";
  byId("strip").setAttribute("aria-expanded", expanded ? "true" : "false");
}

// Shown once, ever. It carries the one thing the buttons can't: what Allow actually costs.
function orientationBanner(): HTMLElement {
  const intro = el("div", "orientation");
  intro.appendChild(el("div", "orientation-title", "Framelink connects an AI agent to this file."));
  intro.appendChild(
    el(
      "div",
      null,
      "Approving a session lets it run code against this document — only approve sessions " +
        "you started. Approval is remembered, even after closing and reopening this plugin, " +
        'until you revoke it here or use "Revoke all approvals".',
    ),
  );
  return intro;
}

// Someone can land here having never heard of Framelink, so the empty state carries the one link
// out. An <a target="_blank"> is the supported way to leave the plugin: window.open works only from
// this iframe, and navigation isn't governed by the manifest's networkAccess.
function emptyState(): HTMLElement {
  const wrap = el("div", "empty");
  wrap.appendChild(
    el("div", null, "No sessions yet. Start the Framelink MCP server in your project and it'll appear here."),
  );
  const link = el("a", "empty-link", "What is Framelink?") as HTMLAnchorElement;
  link.href = "https://framelink.ai";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  wrap.appendChild(link);
  return wrap;
}

// A server this installation isn't paired with. Confirmation happens with the agent, never here: a
// button would let anything that can open a socket ask the human to click it.
function pairingCard(p: PanelPairing): HTMLElement {
  const card = el("div", p.code ? "session waiting" : "session");
  const lines = el("div", "session-lines");
  if (p.code) {
    lines.appendChild(el("div", "session-id", "Pairing code"));
    lines.appendChild(el("div", "pairing-code", p.code));
    lines.appendChild(
      el(
        "div",
        "status-line",
        "Your agent will ask whether this code is shown here. Say yes only if it matches exactly.",
      ),
    );
  } else {
    lines.appendChild(el("div", "session-id", "A Framelink server isn't paired with this plugin yet"));
    lines.appendChild(el("div", "status-line", "It will show a pairing code here when your agent first needs Figma."));
  }
  card.appendChild(lines);
  return card;
}

// A row per live session, and per disconnected one whose request still awaits an answer.
function sessionCard(s: PanelSession): HTMLElement {
  const card = el("div", s.request ? "session " + s.request : "session");
  const lines = el("div", "session-lines");
  lines.appendChild(el("div", "session-id", s.identity || "(unknown project)"));
  card.appendChild(lines);

  const actions = el("div", "actions");
  const button = (className: string, label: string, onClick: () => void): void => {
    const node = el("button", className, label);
    node.onclick = onClick;
    actions.appendChild(node);
  };
  if (s.allowedWhileAway) {
    lines.appendChild(
      el("div", "status-line", "Allowed — applies when this session reconnects. Nothing is waiting to run."),
    );
    button("deny", "Cancel", () => decide(false, s.key));
  } else if (!s.approved) {
    // A session that has never asked needs no line — Allow and Reject already say it.
    if (s.rejected)
      lines.appendChild(el("div", "status-line", "Rejected — its calls are refused. Allow approves it after all."));
    else if (s.request === "waiting")
      lines.appendChild(el("div", "status-line", "Waiting for approval — its call runs once you allow it."));
    else if (s.request === "expired")
      lines.appendChild(
        el(
          "div",
          "status-line",
          s.connected
            ? "Request expired — nothing is waiting to run. Allow approves this session's next call."
            : "Disconnected, request expired — nothing is waiting to run. Allow approves this session when it reconnects.",
        ),
      );
    button("allow", "Allow", () => decide(true, s.key));
    button("deny", s.connected ? "Reject" : "Dismiss", () => decide(false, s.key));
  } else {
    lines.appendChild(
      el("div", s.active ? "status-line driving" : "status-line", s.active ? "● Driving this file" : "Approved — ready to drive"),
    );
    // Revoke, not disconnect — the socket and the row both stay. What goes away is this session's
    // PERMISSION, so its next write asks again.
    button("deny", "Revoke access", () => toSandbox({ type: "UI_REVOKE", connKey: s.key }));
  }
  card.appendChild(actions);
  if (s.approved && s.writeAccess) card.appendChild(writeAccessCard(s.key, s.writeAccess));
  return card;
}

// The server's latest word on this session's write access. Every action is a message to the host,
// which owns both the sign-in request and opening the browser.
function writeAccessCard(connKey: ConnKey, notice: WriteAccessNotice): HTMLElement {
  const box = el("div", "write-access");
  const action = (label: string, type: "UI_SIGN_IN" | "UI_OPEN_SIGN_IN"): void => {
    const row = el("div", "actions");
    const node = el("button", "allow", label);
    node.onclick = () => toSandbox({ type, connKey });
    row.appendChild(node);
    box.appendChild(row);
  };
  if (notice.kind === "allowance-exhausted") {
    box.appendChild(el("div", "write-access-title", "Free writes used up"));
    box.appendChild(
      el(
        "div",
        null,
        "All " + notice.allowance + " free writes this month are used (they reset " +
          notice.resetsAt.slice(0, 10) + " UTC). Writes past the allowance need a Framelink " +
          "seat" + (notice.signedIn ? ", and the signed-in account has none yet." : "."),
      ),
    );
    action(notice.signedIn ? "Sign in again" : "Sign in to Framelink", "UI_SIGN_IN");
  } else if (notice.kind === "sign-in-pending") {
    box.appendChild(el("div", "write-access-title", "Finish signing in in your browser"));
    box.appendChild(el("div", null, "Confirm this code on the Framelink page:"));
    box.appendChild(el("div", "write-access-code", notice.userCode));
    action("Open sign-in page", "UI_OPEN_SIGN_IN");
  } else if (notice.kind === "signed-in") {
    box.appendChild(el("div", "write-access-title", "Signed in to Framelink"));
    box.appendChild(
      el(
        "div",
        null,
        notice.seat === true
          ? "Seat active — writes are unlimited."
          : notice.seat === false
            ? "This account has no seat yet, so writes stay within the free allowance."
            : "Checking your seat — it applies as soon as Framelink answers.",
      ),
    );
  } else {
    box.appendChild(el("div", "write-access-title", "Sign-in didn't finish"));
    box.appendChild(el("div", null, notice.message));
    action("Try again", "UI_SIGN_IN");
  }
  return box;
}

// Shown whenever the host reports ANY remembered approval, independent of the rows above it — a
// persisted approval can outlive its connection, so this is often the only surface for one.
function revokeAllFooter(): HTMLElement {
  const footer = el("div", "footer");
  const node = el("button", "revoke-all", "Revoke all approvals");
  node.title =
    "Forgets every session this plugin has approved — including ones not currently " +
    "connected — so all of them must Allow again, even after this plugin restarts.";
  node.onclick = () => toSandbox({ type: "UI_REVOKE_ALL" });
  footer.appendChild(node);
  return footer;
}

function el(tag: string, className: string | null, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function byId(id: string): HTMLElement {
  return document.getElementById(id)!;
}

// The window is sized from what this document measures, reported on EVERY render, never deduped:
// this document can't observe whether a resize was honored (Figma drops some — see resize in
// session-panel.ts), and a "we already asked for 220" cache strands the window at whatever size it really has.
// Measured inside rAF, after layout, and on #root: the body is stretched to the window by Figma's
// injected styles, so it can never report a height smaller than the window.
function reportHeight(): void {
  requestAnimationFrame(() => toSandbox({ type: "UI_HEIGHT", height: byId("root").offsetHeight }));
}

// The host can't render into an iframe that hasn't loaded, so this document asks for its first paint.
toSandbox({ type: "UI_READY" });
WS_PORT_BLOCK.forEach(connect);
