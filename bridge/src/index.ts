import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WS_PORT_BLOCK } from "./config.js";
import { PluginBridge } from "./bridge.js";
import { detectSkew } from "./version.js";
import { SESSION_IDENTITY } from "./approval.js";
import { log } from "./logger.js";
import { EXECUTE_CODE_DESCRIPTION } from "./tool-docs.js";
import { buildReferenceSections, SECTION_IDS } from "./docs/reference.js";
import { fetchAndProcessImage } from "./images.js";
import { executeWithImages } from "./execute-images.js";

const bridge = new PluginBridge();

bridge.start(WS_PORT_BLOCK, () => {
  // Bridge smoke test: the instant a plugin connects, prove the full loop
  //   server → WS → ui.html → postMessage → code.js → figma.* → back
  // works end to end, before any execute_code wiring exists. If the WS won't
  // round-trip, nothing else in the spike can — so we surface it loudly here.
  bridge
    .request({ type: "PING", payload: "ping from server" })
    .then((reply) => log(`✅ Bridge smoke test passed — sandbox replied: ${JSON.stringify(reply)}`))
    .catch((err: Error) => log(`❌ Bridge smoke test failed: ${err.message}`));

  void handshakeVersion();
  void sendSessionInfo();
});

/**
 * Introduce this session to the plugin so the human can recognize and approve it: the
 * server identity (project path), the connection's pairing code (both shown in the arbiter
 * panel), and — once approved — the session token the sandbox handed us on Allow, echoed on
 * every reconnect so the sandbox re-keys sticky approval to it (null before the first Allow).
 * Fire-and-forget — the plugin acks immediately and records the fields; it must NOT block on
 * the human here (approval arrives later, out of band, via the panel), or this request would
 * hang to its 15s timeout. The plugin owns the approval decision; this just hands it what to
 * display and the token that proves a prior approval.
 */
async function sendSessionInfo(): Promise<void> {
  const pairingCode = bridge.getPairingCode();
  const sessionToken = bridge.getSessionToken();
  await bridge
    .request({ type: "SESSION_INFO", identity: SESSION_IDENTITY, pairingCode, sessionToken })
    .catch(() => {});
}

/**
 * The sandbox gates a write two ways — both RETRYABLE (deliberately not `isError`: the agent should
 * relay the situation to the human and try again, not treat it as terminal):
 *   • PENDING_APPROVAL — the session isn't approved yet. Name the pairing code so the human can Allow.
 *   • INACTIVE_SESSION — the session is approved but another session is the active driver (Invariant:
 *     one writer at a time). Tell the agent to have the human switch the active driver to this session.
 * Both name this server's own per-connection pairing code (single source), so it always matches the
 * row the panel shows. Returns null when the reply isn't a gated one.
 */
function gateResult(reply: unknown): { content: { type: "text"; text: string }[] } | null {
  if (typeof reply !== "object" || reply === null || !("type" in reply)) return null;
  const code = bridge.getPairingCode();
  if (reply.type === "PENDING_APPROVAL") {
    return gateText(
      `This Figma session is not approved yet, so this call did not run. In Figma, open the ` +
        `Code-Mode plugin and click Allow to approve session ${code}. Then retry this exact call — ` +
        `it will run once approved. This is NOT a failure: relay the code "${code}" to the user, ` +
        `wait for them to approve in Figma, and try again.`,
    );
  }
  if (reply.type === "INACTIVE_SESSION") {
    return gateText(
      `This Figma session is approved but another session is currently the active driver, so ` +
        `this call did not run — only one session writes at a time. In Figma, open the Code-Mode ` +
        `plugin and switch the active driver to this session (pairing code ${code}). Then retry ` +
        `this exact call. This is NOT a failure: relay this to the user, wait for them to switch ` +
        `in Figma, and try again.`,
    );
  }
  return null;
}

function gateText(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text }] };
}

/**
 * A per-request handshake preamble prepended to every get_flcm_reference response. It carries the two
 * things the static, drift-checked reference doc can't: the *live* pairing code and a heads-up about the
 * approval gate. A fresh agent calls this docs tool first, so surfacing both here lets it hand the code to
 * the human and expect the approval round-trip BEFORE its first execute_code — instead of learning the
 * code only from a blocked call (the ergo5 first-connect friction this closes).
 *
 * The code is read fresh from the bridge on EVERY call — never cached, never baked into narrative.ts —
 * because it's per-connection and can rotate mid-session (a lapsed session gets reissued a new code with
 * the plugin still connected). The gate line is worded so a *later* "not approved" prompt reads as normal
 * re-approval, and its "not approved yet" phrasing matches gateResult's PENDING_APPROVAL reply so the two
 * read as one handshake.
 *
 * Null code = no plugin connected — the ergo5 first-connect scenario this whole phase targets, so the
 * whole preamble (not just the code line) switches to a coherent cold-start script: there's nothing to
 * relay *yet*, so steer the human to open the plugin and re-read this reference, rather than emitting a
 * "relay the pairing code" instruction that contradicts a missing code.
 */
function referencePreamble(): string {
  const code = bridge.getPairingCode();
  if (!code) {
    return (
      `**No Figma plugin is connected yet, so there's no pairing code.** Ask the user to open the Code-Mode ` +
      `plugin in Figma; a pairing code is issued once it connects, and \`execute_code\` has no sandbox to run ` +
      `in until then.\n\n` +
      `Once it connects, call get_flcm_reference again for the code, relay it to the user, and wait for them ` +
      `to click Allow in Figma before your first \`execute_code\`. If a call replies that the session is ` +
      `"not approved yet", that's the expected approval handshake, NOT a failure — get it approved and retry ` +
      `the exact call. The code is per-session and can rotate, so a later re-approval prompt is also normal.`
    );
  }
  const pairingLine =
    `**Pairing code ${code}.** Relay this to the user before your first \`execute_code\` — they'll see it ` +
    `in the Code-Mode plugin's panel in Figma and click Allow to approve this session.`;
  const gateLine =
    `Your first \`execute_code\` may reply that this Figma session is "not approved yet" — that is the ` +
    `expected approval handshake, NOT a failure: relay the pairing code, wait for the user to click Allow ` +
    `in Figma, then retry the exact call. The code is per-session and can rotate, so being asked to ` +
    `re-approve later in the session is also normal — re-read this reference for the current code if so.`;
  return `${pairingLine}\n\n${gateLine}`;
}

// The plugin answers GET_VERSION with this shape. Both fields are optional: a plugin
// predating the handshake never sends them — it ERRORs (request rejects → caught into {})
// and a malformed reply safeParses to {} — so the absence flows into detectSkew as the
// floor and nudges, never throws.
const VersionReply = z.object({
  pluginVersion: z.string().optional(),
  protocolVersion: z.number().optional(),
});

/**
 * Server-initiated version handshake (fires on every connect, alongside the PING). Asks
 * the sandbox for its versions over the frozen envelope, gates them against the supported
 * minimum, and — on skew — arms BOTH nudge channels: a figma.notify toast (human, routed
 * back through the sandbox) and the agent note appended to subsequent tool results.
 *
 * A plugin predating the handshake answers GET_VERSION with an envelope ERROR; we catch
 * that into an empty record so detectSkew treats it as the floor and nudges, never rejects.
 */
async function handshakeVersion(): Promise<void> {
  const epoch = bridge.currentEpoch();
  const reply = await bridge.request({ type: "GET_VERSION" }).catch(() => ({}));
  // If the slot was reclaimed/reconnected while we awaited, a DIFFERENT connection now owns it
  // and runs its own handshake. Bail so this stale connection's result — e.g. a displaced
  // squatter's GET_VERSION timing out to {} → nudge — can't clobber the current plugin's note.
  if (bridge.currentEpoch() !== epoch) return;
  const version = VersionReply.safeParse(reply).data ?? {};
  const note = detectSkew(version);
  bridge.setSkewNote(note);
  if (!note) return;
  log(`⚠️ Version skew — plugin reported ${JSON.stringify(version)}; nudging both channels`);
  // Fire-and-forget: a spike-era plugin predating the NOTIFY handler answers with an
  // envelope ERROR (rejecting this request) and the toast is silently dropped — expected,
  // that plugin still gets the agent channel. Don't chase a toast on a pre-v1 plugin.
  bridge.request({ type: "NOTIFY", message: note }).catch(() => {});
}

/**
 * Append the connection's version-skew nudge to a tool result so the agent sees it and
 * relays the upgrade prompt to the human. No-op when the plugin is current. This is the
 * agent half of the dual-channel nudge — the half that reaches even a pre-v1 plugin, which
 * can't render the human toast.
 */
function withSkewNote<T>(content: T[]): (T | { type: "text"; text: string })[] {
  const note = bridge.getSkewNote();
  return note ? [...content, { type: "text" as const, text: note }] : content;
}

const server = new McpServer({ name: "figma-code-mode-spike", version: "0.0.1" });

// The execute_code description is the generated quick-start (buildQuickStart, via tool-docs.ts), assembled
// from the schema single-source + narrative — so the agent-facing contract can't drift from the code
// (that drift once shipped a description of a deleted API). It is always inline in the tool description
// (not a separate resource) so it is ALWAYS in the agent's context when it writes code — the whole bet is
// that one tool + this contract beats dozens of granular tools. Full docs live in get_flcm_reference.

server.registerTool(
  "execute_code",
  {
    description: EXECUTE_CODE_DESCRIPTION,
    inputSchema: {
      code: z
        .string()
        .describe("JavaScript to run in the Figma sandbox. Runs in an async body; use await freely; return a value."),
    },
  },
  async ({ code }) => {
    // Correlation ids and the "no plugin connected" rejection are owned by PluginBridge; the image
    // fetch + re-execute two-pass is owned by executeWithImages — this handler wires the real
    // bridge/gate/fetch seams and shapes the outcome into a tool reply.
    const outcome = await executeWithImages(code, {
      request: (c) => bridge.request({ type: "EXECUTE_CODE", code: c }),
      gate: gateResult,
      fetchImage: fetchAndProcessImage,
    });
    if (outcome.kind === "gated") return outcome.result;
    if (outcome.kind === "error") {
      return { content: withSkewNote([{ type: "text", text: outcome.message }]), isError: true };
    }
    return {
      content: withSkewNote([{ type: "text", text: JSON.stringify(outcome.reply, null, 2) }]),
    };
  },
);

// The full flcm authoring reference, delivered as a TOOL (not a resource): the ~18.5K contract can't fit
// the 2KB execute_code description, and MCP resources are user-gated / unevenly supported across clients.
// A tool is the universal, autonomously-callable channel — the established pattern for shipping docs to
// agents. Sectioned so a single call stays well under the ~25K tool-result budget as the surface grows.
server.registerTool(
  "get_flcm_reference",
  {
    description:
      "Full authoring reference for the `flcm` DSL used in execute_code. Call with no argument for the " +
      "index + cheat-sheet, an array of section ids for those sections (deduped, in canonical order), or " +
      '["all"] for the entire reference in one call. Sections: ' + SECTION_IDS.join(", ") + ".",
    inputSchema: {
      sections: z
        .array(z.enum(["all", ...SECTION_IDS]))
        .optional()
        .describe('Which sections to return, e.g. ["props","effects"]. Use ["all"] for the whole reference. Omit for the index + cheat-sheet.'),
    },
  },
  async ({ sections }) => ({
    content: [
      { type: "text", text: referencePreamble() },
      { type: "text", text: buildReferenceSections(sections) },
    ],
  }),
);

// The sandbox posts exactly one of these (see screenshot() in code.ts): `image`
// (base64 PNG) on success, `errors` on the failure path — never both, never neither.
const ScreenshotReply = z.union([z.object({ image: z.string() }), z.object({ errors: z.string() })]);

server.registerTool(
  "get_screenshot",
  {
    description: `Capture a PNG of what you've built so you can see it and self-correct.

Pass a nodeId (e.g. a frame's id returned from execute_code) to screenshot just that node; omit it to snapshot the whole current page. Returns a PNG image.`,
    inputSchema: {
      nodeId: z
        .string()
        .optional()
        .describe("Id of the node to screenshot. Omit to capture the whole current page."),
    },
  },
  async ({ nodeId }) => {
    const raw = await bridge.request({ type: "SCREENSHOT", nodeId });
    const gated = gateResult(raw);
    if (gated) return gated;
    const reply = ScreenshotReply.parse(raw);
    if ("errors" in reply) {
      return { content: [{ type: "text", text: reply.errors }], isError: true };
    }
    return { content: withSkewNote([{ type: "image", data: reply.image, mimeType: "image/png" }]) };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log("MCP server connected over stdio");
