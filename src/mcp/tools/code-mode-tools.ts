import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PluginBridgeRuntime } from "~/services/plugin-bridge/index.js";
import {
  requestUntilApproved,
  isPendingApproval,
  APPROVAL_WAIT_MS,
  PLUGIN_CONNECT_WAIT_MS,
} from "~/services/plugin-bridge/await-approval.js";
import type { ServerTransport } from "~/mcp/index.js";
import { registerFailLoudTool, retryableToolReply } from "~/mcp/fail-loud-params.js";
import { buildQuickStart, buildReferenceSections, SECTION_IDS } from "./flcm-docs/reference.js";

// The figma_execute_code description is the GENERATED quick-start (buildQuickStart), assembled from
// the schema single-source + narrative — so the agent-facing contract can't drift from the code
// (that drift once shipped a description of a deleted API). It is always inline in the tool
// description (not a separate resource) so it is ALWAYS in the agent's context when it writes code —
// the whole bet is that one tool + this contract beats dozens of granular tools. Full docs live in
// get_flcm_reference.
const EXECUTE_CODE_DESCRIPTION = buildQuickStart();

// The plugin always replies to EXECUTE_CODE with this exact shape; parse it once so the handler
// trusts the type instead of re-checking each field. `result` is absent when the code returns
// nothing or throws: undefined isn't JSON, so it's dropped crossing the WS — optional, not
// required (a missing key is the error/void path). Since protocol 2, images are fetched MID-RUN
// (PluginBridge.serveImagesRequest), so a script executes exactly once and this reply is the
// whole story — no re-run signals, no second pass.
const ExecuteCodeReply = z.object({
  result: z.unknown().optional(),
  console: z.array(z.string()),
  errors: z.string().nullable(),
});

// The sandbox posts exactly one of these (see screenshot() in code.ts): `image`
// (base64 PNG) on success, `errors` on the failure path — never both, never neither.
const ScreenshotReply = z.union([
  z.object({ image: z.string() }),
  z.object({ errors: z.string() }),
]);

// Upper cap on the screenshot export scale, so a fat-fingered `scale: 40` can't ask Figma to export a
// page-sized PNG at absurd resolution (and blow the agent's image budget on the way back). 4x already
// resolves hairlines and grain, and matches the top of Figma's own export-scale UI.
const MAX_SCREENSHOT_SCALE = 4;

// Both the gate text and the reference preamble quote the hold window to the agent; the ceiling is a
// whole number of seconds by construction, so this is a display conversion, not a rounding.
const APPROVAL_WAIT_SECONDS = APPROVAL_WAIT_MS / 1000;

type CodeModeToolsOptions = {
  /** Force the tools to be advertised from startup (`--code-mode`) instead of waiting for a plugin. */
  codeMode: boolean;
  transport: ServerTransport;
};

/**
 * Register the code-mode (write-path) tools: figma_execute_code, get_flcm_reference, get_screenshot.
 *
 * Dynamic exposure: the tools are registered but DISABLED until a Figma plugin connects to the WS
 * relay, so the many read-only users of this server never see write tools in tools/list. On stdio —
 * a single long-lived connection — the first plugin connection enables them live and the SDK emits
 * notifications/tools/list_changed. On stateless HTTP every request builds a fresh server, so the
 * latch is simply read at construction time; there is no long-lived connection to notify (GETs are
 * 405'd — no SSE stream exists to carry a notification). `--code-mode` forces always-on registration
 * for list-caching clients that ignore list_changed.
 */
export function registerCodeModeTools(
  server: McpServer,
  runtime: PluginBridgeRuntime,
  { codeMode, transport }: CodeModeToolsOptions,
): void {
  const { bridge } = runtime;

  /**
   * Every write-path request goes out through both holds, wired to this bridge: first the post-restart
   * reconnect wait (a call can arrive before the plugin has redialed the freshly bound relay), then the
   * approval hold across the human's Allow. One place, so the two write tools can't drift on either.
   */
  function requestHeldOpen(send: () => Promise<unknown>): Promise<unknown> {
    return requestUntilApproved(send, {
      awaitPluginConnection: () => bridge.waitForPluginConnection(PLUGIN_CONNECT_WAIT_MS),
    });
  }

  /**
   * The sandbox gates a write exactly ONE way — consent — and the gate is RETRYABLE (deliberately not
   * `isError`: the agent should relay the situation to the human and try again, not treat it as
   * terminal). PENDING_APPROVAL means the session isn't approved yet; the text names this server's own
   * per-connection pairing code (single source) so it always matches the row the plugin shows.
   * Returns null when the reply isn't a gated one.
   *
   * Reaching here means the call ALREADY waited out requestUntilApproved's full window — the agent only
   * sees this text when the human didn't click within it, so the wording says so. The common case (a
   * human at the keyboard) never produces this result at all; the wait returns the real one.
   */
  function gateResult(reply: unknown): { content: { type: "text"; text: string }[] } | null {
    if (!isPendingApproval(reply)) return null;
    const code = bridge.getPairingCode();
    const text =
      `This Figma session is not approved yet, so this call did not run — the server held the call open ` +
      `for ${APPROVAL_WAIT_SECONDS}s waiting for approval and it didn't arrive. In Figma, open ` +
      `the Framelink plugin and click Allow to approve session ${code}, then retry this exact call — it ` +
      `will run as soon as it's approved. This is NOT a failure: relay the code "${code}" to the user, ` +
      `make sure they've approved it in Figma, and try again.`;
    return { content: [{ type: "text", text }] };
  }

  /**
   * A per-request handshake preamble prepended to every get_flcm_reference response. It carries the two
   * things the static, drift-checked reference doc can't: the *live* pairing code and a heads-up about the
   * approval gate. A fresh agent calls this docs tool first, so surfacing both here lets it hand the code to
   * the human and expect the approval round-trip BEFORE its first figma_execute_code — instead of learning
   * the code only from a blocked call (the ergo5 first-connect friction this closes).
   *
   * The code is read fresh from the bridge on EVERY call — never cached, never baked into narrative.ts —
   * because it's per-connection and can rotate mid-session (a lapsed session gets reissued a new code with
   * the plugin still connected). The gate line is worded so a *later* "not approved" prompt reads as normal
   * re-approval, and its "not approved yet" phrasing matches gateResult's PENDING_APPROVAL reply so the two
   * read as one handshake.
   *
   * Null code = no plugin connected — reachable under `--code-mode` (always-advertised) and in the window
   * between a disconnect and the plugin's ~1s reconnect, since advertisement latches on. There's nothing to
   * relay *yet*, so the whole preamble (not just the code line) switches to a coherent cold-start script:
   * steer the human to open the plugin and re-read this reference, rather than emitting a "relay the
   * pairing code" instruction that contradicts a missing code.
   */
  function referencePreamble(): string {
    const code = bridge.getPairingCode();
    if (!code) {
      return (
        `**No Figma plugin is connected yet, so there's no pairing code.** Ask the user to open the Framelink ` +
        `plugin in Figma; a pairing code is issued once it connects, and \`figma_execute_code\` has no sandbox ` +
        `to run in until then.\n\n` +
        `Once it connects, call get_flcm_reference again for the code and relay it to the user before your ` +
        `first \`figma_execute_code\`. An unapproved call doesn't fail — the server holds it open while it ` +
        `waits for the user to click Allow — so relaying the code FIRST is what keeps that wait short. ` +
        `The code is per-session and can rotate, so a later re-approval prompt is also normal.`
      );
    }
    const pairingLine =
      `**Pairing code ${code}.** Relay this to the user before your first \`figma_execute_code\` — they'll see ` +
      `it on the Framelink plugin's status strip in Figma and click Allow to approve this session.`;
    const gateLine =
      `If the session isn't approved yet, your \`figma_execute_code\` call does NOT come back with an error — the ` +
      `server holds it open for up to ${APPROVAL_WAIT_SECONDS}s and runs it the moment the user ` +
      `clicks Allow, so a single call is usually all you need. That's why relaying the pairing code BEFORE you ` +
      `call matters: the user should already be looking at Figma. Only if the wait runs out do you get a ` +
      `"not approved yet" reply, which is retryable, NOT a failure. The code is per-session and can rotate, so ` +
      `being asked to re-approve later is also normal — re-read this reference for the current code if so.`;
    return `${pairingLine}\n\n${gateLine}`;
  }

  /**
   * The protocol gate: a plugin below MIN_PROTOCOL_VERSION cannot speak the mid-run image
   * protocol (the DSL runtime ships in the plugin bundle), so write tools REFUSE outright and
   * name the re-import fix — no compat path, nothing shipped before v2. The refusal is the
   * agent half of the dual-channel skew message (the human half is the connect toast); it
   * reaches even a pre-handshake plugin, which can't render the toast.
   *
   * The rule for which tools it guards: a tool that TOUCHES THE CANVAS (or reads it — screenshots)
   * is refused outright; a docs tool still serves, with the note PREPENDED (get_flcm_reference).
   * One refusal moment with one fix beats a tool-by-tool capability matrix, and docs can't corrupt
   * anything — annotating them is how the agent learns the fix before its first refused write.
   *
   * Known soft edge, accepted: the note is set by the connect-time GET_VERSION handshake, so a
   * write racing into the few-ms window before that resolves slips past this gate. Real agent
   * writes arrive seconds after connect at the earliest.
   */
  function skewRefusal(): { content: { type: "text"; text: string }[]; isError: true } | null {
    const note = bridge.getSkewNote();
    return note ? { content: [{ type: "text" as const, text: note }], isError: true } : null;
  }

  // Every code-mode tool registers through registerFailLoudTool, not server.registerTool: a mistyped
  // param must come back as a named, retryable error instead of being silently stripped (see
  // fail-loud-params.ts).
  const tools = [
    registerFailLoudTool(
      server,
      "figma_execute_code",
      {
        description: EXECUTE_CODE_DESCRIPTION,
        inputSchema: {
          code: z
            .string()
            .describe(
              "JavaScript to run in the Figma sandbox. Runs in an async body; use await freely; return a value.",
            ),
        },
      },
      async ({ code }) => {
        const refused = skewRefusal();
        if (refused) return refused;
        // Correlation ids and the "no plugin connected" rejection are owned by PluginBridge; mid-run
        // image fetches ride the bridge underneath this single execute (serveImagesRequest). The
        // wait holds the call open across a plugin reconnect and then across the human's Allow,
        // rather than returning "not approved yet" for the agent to retry — see requestHeldOpen.
        const raw = await requestHeldOpen(() => bridge.request({ type: "EXECUTE_CODE", code }));
        const gated = gateResult(raw);
        if (gated) return gated;
        const reply = ExecuteCodeReply.parse(raw);
        // A write actually ran: slide the persisted approval's TTL forward so an active session never
        // lapses mid-work (durable-approval, this cycle). No-op when the session isn't persisted.
        bridge.touchApproval();
        return {
          content: [{ type: "text", text: JSON.stringify(reply, null, 2) }],
        };
      },
    ),

    // The full flcm authoring reference, delivered as a TOOL (not a resource): the ~18.5K contract can't fit
    // the 2KB figma_execute_code description, and MCP resources are user-gated / unevenly supported across
    // clients. A tool is the universal, autonomously-callable channel — the established pattern for shipping
    // docs to agents. Sectioned so a single call stays well under the ~25K tool-result budget as the surface
    // grows.
    registerFailLoudTool(
      server,
      "get_flcm_reference",
      {
        description:
          "Full authoring reference for the `flcm` DSL used in figma_execute_code. Call with no argument for " +
          "the index + cheat-sheet, an array of section ids for those sections (deduped, in canonical order), " +
          'or ["all"] for the entire reference in one call. Sections: ' +
          SECTION_IDS.join(", ") +
          ".",
        inputSchema: {
          sections: z
            .array(z.enum(["all", ...SECTION_IDS]))
            .optional()
            .describe(
              'Which sections to return, e.g. ["props","effects"]. Use ["all"] for the whole reference. Omit for the index + cheat-sheet.',
            ),
        },
      },
      async ({ sections }) => {
        // Docs still serve on a stale plugin — but lead with the refusal text so the agent learns
        // the re-import fix here, before its first (refused) write.
        const note = bridge.getSkewNote();
        return {
          content: [
            ...(note ? [{ type: "text" as const, text: note }] : []),
            { type: "text" as const, text: referencePreamble() },
            { type: "text" as const, text: buildReferenceSections(sections) },
          ],
        };
      },
    ),

    registerFailLoudTool(
      server,
      "get_screenshot",
      {
        description: `Capture a PNG of what you've built so you can see it and self-correct. Build → screenshot → look → fix.

Target ONE node, or omit both targets to snapshot the whole current page:
- nodeId — a node's id. Copy it from a figma_execute_code result: \`(await flcm.render(tree)).root.id\`, or any handle's \`.id\` in \`.keyed\`.
- key — a key you authored on a node (\`flcm.frame({ key: "card" }, …)\`). An unknown key, or one matching several nodes (duplicating a node copies its key), fails loud rather than guessing.

Passing both nodeId and key is ambiguous and fails loud. A failed lookup NEVER falls back to the whole page.

scale (default 1, max 4) multiplies the export resolution — use scale: 2–4 to inspect detail you can't resolve at 1x: hairline borders, 1px strokes, grain, glass refraction, small type.

Returns a PNG image.`,
        inputSchema: {
          nodeId: z
            .string()
            .optional()
            .describe(
              "Id of the node to screenshot (from a render handle's .id). Omit both nodeId and key to capture the whole current page.",
            ),
          key: z
            .string()
            .optional()
            .describe(
              "Key of the node to screenshot, as authored via a node's `key` prop. Mutually exclusive with nodeId.",
            ),
          scale: z
            .number()
            .optional()
            .describe(
              `Export resolution multiplier, greater than 0 and at most ${MAX_SCREENSHOT_SCALE} (default 1). Raise it to inspect fine detail.`,
            ),
        },
      },
      async ({ nodeId, key, scale }) => {
        const refused = skewRefusal();
        if (refused) return refused;
        // Value-level target checks (Phase 1 covers UNKNOWN keys; nodeId/key/scale are all known, so
        // their misuse is checked here). Same retryable shape: the agent can fix the call and retry.
        if (nodeId !== undefined && key !== undefined) {
          return retryableToolReply(
            `get_screenshot got both nodeId ("${nodeId}") and key ("${key}"), which is ambiguous, so ` +
              `this call did not run. Pass exactly one target — or neither, to capture the whole current ` +
              `page. This is NOT a failure: retry with a single target.`,
          );
        }
        if (scale !== undefined && !(scale > 0 && scale <= MAX_SCREENSHOT_SCALE)) {
          return retryableToolReply(
            `get_screenshot got scale ${scale}, which is outside the supported range (greater than 0, at ` +
              `most ${MAX_SCREENSHOT_SCALE}), so this call did not run — an unbounded scale can try to ` +
              `export a page-sized image at absurd resolution. This is NOT a failure: retry with a scale ` +
              `in range (2–4 is plenty for inspecting fine detail).`,
          );
        }
        const raw = await requestHeldOpen(() =>
          bridge.request({ type: "SCREENSHOT", nodeId, key, scale }),
        );
        const gated = gateResult(raw);
        if (gated) return gated;
        const reply = ScreenshotReply.parse(raw);
        if ("errors" in reply) {
          return { content: [{ type: "text", text: reply.errors }], isError: true };
        }
        return {
          content: [{ type: "image", data: reply.image, mimeType: "image/png" }],
        };
      },
    ),
  ];

  if (codeMode || runtime.hasEverConnected()) return;

  // Hidden until a plugin proves the write path exists. disable() before the transport connects is
  // a silent flag flip (the SDK skips the list_changed notification when disconnected), so clients
  // never see a flap. Only stdio subscribes to the latch: its one server outlives the whole session,
  // while stateless HTTP builds a fresh server per request — each request re-reads the latch above,
  // and subscribing those short-lived servers would accumulate dead closures until first connect.
  for (const tool of tools) tool.disable();
  if (transport === "stdio") {
    runtime.onFirstConnect(() => {
      for (const tool of tools) tool.enable();
    });
  }
}
