/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The plugin's ONLY network context (the host, code.ts, has no WS access), so this iframe relays
// server↔host traffic without reading it. It is ALSO the plugin's only human surface: an always-
// visible status strip that expands into the grant list. The host drives it with one render
// envelope and owns every decision; this file only reports clicks and its own measured height.
// Messages both ways are typed in panel.ts. build.mjs inlines the bundle into dist/ui.html.
import { PLUGIN_REDIAL_MAX_MS, WS_PORT_BLOCK, type WriteAccessNotice } from "./protocol.js";
import type {
  ActivityOutcome,
  ConnKey,
  HostInbound,
  HostOutbound,
  PanelActivity,
  PanelControl,
  PanelPairing,
  PanelPrompt,
  PanelRender,
  PanelGrantRow,
} from "./panel.js";

// Discovery is keyed by port; host traffic by socket generation, which never reuses a port's number.
const sockets = new Map<number, WebSocket>();
const routes = new Map<ConnKey, WebSocket>();
let nextConnectionKey = 0;

// Reconnect cadence, per port. A port that has NEVER opened is almost certainly empty, so its retries
// back off 1s → 15s. This is purely to tame console noise: every doomed connect emits a browser-level
// "WebSocket connection to … failed" line that JS cannot catch or mute. A port that has opened (a// real server) stays on the fast cadence so a dropped/restarted server reappears promptly.
const BASE_RECONNECT_MS = 1000;
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
// server, and onclose is the disconnect signal. `localhost`, never 127.0.0.1: Figma's manifest
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
    // A FRESH connection: the host starts it unauthenticated and ungranted, so a different local
    // server that grabbed a freed port can't ride the previous socket's standing. onopen fires before any onmessage on this
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
      reconnectDelays.set(port, Math.min(previous * 2, PLUGIN_REDIAL_MAX_MS));
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

// Allow / Deny → the host (sole arbiter), tagged with the call and the document the prompt showed.
// The button carries NO grant logic: it reports the human's choice; the host records the grant.
function decide(approve: boolean, { key, executionId, documentId }: PanelPrompt): void {
  toSandbox({ type: "UI_DECISION", approve, connKey: key, executionId, documentId });
}

byId("strip").onclick = () => toSandbox({ type: "UI_TOGGLE" });

// The whole surface from one render: the always-on strip, plus — when expanded — the grant list.
// Built with textContent, never innerHTML, so a project path can't inject markup.
function render(state: PanelRender): void {
  renderStrip(state);
  const detail = byId("detail");
  detail.textContent = "";
  detail.style.display = state.expanded ? "flex" : "none";
  if (state.expanded) {
    if (state.showOrientation) detail.appendChild(orientationBanner());
    if (state.grantStorageError) detail.appendChild(el("div", "orientation", state.grantStorageError));
    if (state.document) detail.appendChild(documentCard(state.document));
    if (!state.grantRows.length && !state.pairings.length) detail.appendChild(emptyState());
    for (const pairing of state.pairings) detail.appendChild(pairingCard(pairing));
    for (const prompt of state.prompts) detail.appendChild(promptCard(prompt));
    for (const row of state.grantRows) detail.appendChild(grantRowCard(row));
    if (state.activity.length) detail.appendChild(activityFeed(state.activity));
  }
  reportHeight();
}

// One glanceable line, in priority order: a code to confirm > a decision you owe > a file agents
// can't use > spent writes > what is running > who is driving > who is ready.
function renderStrip({ pairings, prompts, activity, grantRows, document: doc, expanded }: PanelRender): void {
  let granted = 0;
  let active: PanelGrantRow | null = null;
  let writesSpent = false;
  for (const s of grantRows) {
    if (s.granted) granted++;
    if (s.active) active = s;
    if (s.writeAccess?.kind === "allowance-exhausted") writesSpent = true;
  }
  const wants = prompts.filter((prompt) => !prompt.allowing).length;
  const running = activity.find((entry) => entry.outcome === "running");

  const offered = pairings.filter((p) => p.code !== null);
  let text: string;
  let tone: string;
  if (offered.length) {
    text = offered.length === 1 ? "Pairing code " + offered[0].code : offered.length + " pairing codes to check";
    tone = "wants";
  } else if (wants) {
    text = wants === 1 ? "An agent is waiting on you" : wants + " agents are waiting on you";
    tone = "wants";
  } else if (doc?.kind === "unidentified") {
    text = "Agents can't use this file";
    tone = "wants";
  } else if (writesSpent) {
    // Writes are being refused until the human acts, so it outranks who is driving.
    text = "Free writes used up — sign in to keep writing";
    tone = "wants";
  } else if (running) {
    text = running.intent;
    tone = "live";
  } else if (active) {
    text = active.label + " — driving";
    tone = "live";
  } else if (granted === 1) {
    text = (grantRows.find((s) => s.granted)?.label ?? "A project") + " — ready";
    tone = "ready";
  } else if (granted) {
    text = granted + " projects ready";
    tone = "ready";
  } else {
    text = "Waiting for a Framelink server…";
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
      "Allowing a project lets every agent working in that project run code against this file — " +
        "only allow projects you started agents in. The grant is remembered, even after closing " +
        "and reopening this plugin, until you revoke it here.",
    ),
  );
  return intro;
}

// Which file this is, by the stamp this plugin keeps in it. The id is what agents name the file by.
function documentCard(doc: NonNullable<PanelRender["document"]>): HTMLElement {
  const card = el("div", doc.kind === "unidentified" ? "card waiting" : "card");
  const lines = el("div", "card-lines");
  card.appendChild(lines);
  if (doc.kind === "identified") {
    lines.appendChild(el("div", "card-title", doc.fileName));
    lines.appendChild(el("div", "status-line", "Agents name this file as document " + doc.documentId + "."));
    return card;
  }
  lines.appendChild(el("div", "card-title", "Agents can't use this file"));
  lines.appendChild(el("div", "status-line", doc.problem));
  return card;
}

// One call waiting on the human. Several can wait at once, each with its own buttons, so a click
// always answers the call it was drawn for.
function promptCard(p: PanelPrompt): HTMLElement {
  const card = el("div", "card waiting");
  const lines = el("div", "card-lines");
  lines.appendChild(el("div", "card-title", p.project));
  // The agent's own words for this call, so the human knows what they are answering.
  lines.appendChild(el("div", "intent", "“" + p.intent + "”"));
  card.appendChild(lines);
  const actions = el("div", "actions");
  const button = (className: string, label: string, onClick: () => void): void => {
    const node = el("button", className, label);
    node.onclick = onClick;
    actions.appendChild(node);
  };
  if (p.kind === "pick") {
    // Two open files carry this document's id: a duplicate, most often. The agent can't tell them
    // apart, so the human says which one this call means.
    lines.appendChild(
      el("div", "status-line", "This file is open twice, or has a copy open. Is this the one the agent should edit?"),
    );
    button("allow", "Use this one", () =>
      toSandbox({ type: "UI_PICK", connKey: p.key, executionId: p.executionId, documentId: p.documentId }),
    );
    button("deny", "Give this copy its own identity", () => toSandbox({ type: "UI_RESTAMP" }));
  } else if (p.allowing) {
    lines.appendChild(el("div", "status-line", "Saving…"));
  } else {
    lines.appendChild(
      el("div", "status-line", "Wants to edit this file. Allow lets every agent in this project edit it."),
    );
    button("allow", "Allow", () => decide(true, p));
    button("deny", "Deny", () => decide(false, p));
  }
  card.appendChild(actions);
  return card;
}

const OUTCOME_TEXT: Record<ActivityOutcome, string> = {
  waiting: "Waiting for you",
  "not-run": "Didn't run here",
  allowed: "Allowed — starting",
  picked: "Picked — starting",
  denied: "Denied",
  refused: "Refused — nothing ran",
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

// What each agent call did in this file lately, newest first: its intent, its outcome, and the
// session it ran in, which is how one agent's calls are told from another's.
function activityFeed(activity: PanelActivity[]): HTMLElement {
  const feed = el("div", "activity");
  feed.appendChild(el("div", "activity-title", "Recent activity"));
  for (const entry of activity) {
    const row = el("div", "activity-entry");
    row.appendChild(el("div", "intent", entry.intent));
    const parts = [OUTCOME_TEXT[entry.outcome], entry.label];
    if (entry.session) parts.push(entry.session);
    row.appendChild(el("div", "status-line", parts.join(" · ")));
    feed.appendChild(row);
  }
  return feed;
}

// Someone can land here having never heard of Framelink, so the empty state carries the one link
// out. An <a target="_blank"> is the supported way to leave the plugin: window.open works only from
// this iframe, and navigation isn't governed by the manifest's networkAccess.
function emptyState(): HTMLElement {
  const wrap = el("div", "empty");
  wrap.appendChild(
    el("div", null, "No servers yet. Start the Framelink MCP server in your project and it'll appear here."),
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
  const card = el("div", p.code ? "card waiting" : "card");
  const lines = el("div", "card-lines");
  if (p.code) {
    lines.appendChild(el("div", "card-title", "Pairing code"));
    lines.appendChild(el("div", "pairing-code", p.code));
    lines.appendChild(
      el(
        "div",
        "status-line",
        "Your agent will ask whether this code is shown here. Say yes only if it matches exactly.",
      ),
    );
  } else {
    lines.appendChild(el("div", "card-title", "A Framelink server isn't paired with this plugin yet"));
    lines.appendChild(el("div", "status-line", "It will show a pairing code here when your agent first needs Figma."));
  }
  card.appendChild(lines);
  return card;
}

// A row per connected server, and per project granted this file whose servers are all gone.
function grantRowCard(s: PanelGrantRow): HTMLElement {
  const card = el("div", "card");
  const lines = el("div", "card-lines");
  lines.appendChild(el("div", "card-title", s.project || "(unknown project)"));
  card.appendChild(lines);

  const actions = el("div", "actions");
  const button = (className: string, label: string, onClick: () => void): void => {
    const node = el("button", className, label);
    node.onclick = onClick;
    actions.appendChild(node);
  };
  const revoke = (): void => {
    const grant = s.grant;
    if (!grant) return;
    // Revoke, not disconnect: the socket and the row both stay. What goes is the PROJECT's grant
    // on this file, so every agent in it is stopped and its next write asks again.
    button("deny", "Revoke", () => toSandbox({ type: "UI_REVOKE", ...grant }));
  };
  if (s.granted) {
    lines.appendChild(
      el(
        "div",
        s.active ? "status-line driving" : "status-line",
        s.active ? "● Driving this file" : s.connected ? "Allowed to edit this file" : "Allowed — not connected now",
      ),
    );
    lines.appendChild(el("div", "status-line", "Revoking stops every agent in this project."));
    revoke();
  } else {
    lines.appendChild(el("div", "status-line", "Connected — not allowed to edit this file"));
  }
  card.appendChild(actions);
  if (s.granted && s.key !== null && s.writeAccess) card.appendChild(writeAccessCard(s.key, s.writeAccess));
  return card;
}

// The server's latest word on this row's write access. Every action is a message to the host,
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
    // eslint-disable-next-line no-restricted-syntax -- a wire field, not an error's text
    box.appendChild(el("div", null, notice.message));
    action("Try again", "UI_SIGN_IN");
  }
  return box;
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
// grant-panel.ts), and a "we already asked for 220" cache strands the window at whatever size it really has.
// Measured inside rAF, after layout, and on #root: the body is stretched to the window by Figma's
// injected styles, so it can never report a height smaller than the window.
function reportHeight(): void {
  requestAnimationFrame(() => toSandbox({ type: "UI_HEIGHT", height: byId("root").offsetHeight }));
}

// The host can't render into an iframe that hasn't loaded, so this document asks for its first paint.
toSandbox({ type: "UI_READY" });
WS_PORT_BLOCK.forEach(connect);
