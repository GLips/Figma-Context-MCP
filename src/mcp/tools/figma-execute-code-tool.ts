import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PluginBridgeRuntime } from "~/services/plugin-bridge/index.js";
import { fetchAndProcessImage } from "~/services/plugin-bridge/images.js";
import { executeWithImages } from "~/services/plugin-bridge/execute-images.js";
import { buildQuickStart, buildReferenceSections, SECTION_IDS } from "./flcm-docs/reference.js";

// The figma_execute_code description is the GENERATED quick-start (buildQuickStart), assembled from
// the schema single-source + narrative — so the agent-facing contract can't drift from the code
// (that drift once shipped a description of a deleted API). It is always inline in the tool
// description (not a separate resource) so it is ALWAYS in the agent's context when it writes code —
// the whole bet is that one tool + this contract beats dozens of granular tools. Full docs live in
// get_flcm_reference.
export const EXECUTE_CODE_DESCRIPTION = buildQuickStart();

export type CodeModeToolsOptions = {
  /** Force the tools to be advertised from startup (`--code-mode`) instead of waiting for a plugin. */
  codeMode: boolean;
  transport: "stdio" | "http";
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
        `**No Figma plugin is connected yet, so there's no pairing code.** Ask the user to open the Code-Mode ` +
        `plugin in Figma; a pairing code is issued once it connects, and \`figma_execute_code\` has no sandbox ` +
        `to run in until then.\n\n` +
        `Once it connects, call get_flcm_reference again for the code, relay it to the user, and wait for them ` +
        `to click Allow in Figma before your first \`figma_execute_code\`. If a call replies that the session is ` +
        `"not approved yet", that's the expected approval handshake, NOT a failure — get it approved and retry ` +
        `the exact call. The code is per-session and can rotate, so a later re-approval prompt is also normal.`
      );
    }
    const pairingLine =
      `**Pairing code ${code}.** Relay this to the user before your first \`figma_execute_code\` — they'll see ` +
      `it in the Code-Mode plugin's panel in Figma and click Allow to approve this session.`;
    const gateLine =
      `Your first \`figma_execute_code\` may reply that this Figma session is "not approved yet" — that is the ` +
      `expected approval handshake, NOT a failure: relay the pairing code, wait for the user to click Allow ` +
      `in Figma, then retry the exact call. The code is per-session and can rotate, so being asked to ` +
      `re-approve later in the session is also normal — re-read this reference for the current code if so.`;
    return `${pairingLine}\n\n${gateLine}`;
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

  const tools: RegisteredTool[] = [];

  tools.push(
    server.registerTool(
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
          return {
            content: withSkewNote([{ type: "text", text: outcome.message }]),
            isError: true,
          };
        }
        return {
          content: withSkewNote([{ type: "text", text: JSON.stringify(outcome.reply, null, 2) }]),
        };
      },
    ),
  );

  // The full flcm authoring reference, delivered as a TOOL (not a resource): the ~18.5K contract can't fit
  // the 2KB figma_execute_code description, and MCP resources are user-gated / unevenly supported across
  // clients. A tool is the universal, autonomously-callable channel — the established pattern for shipping
  // docs to agents. Sectioned so a single call stays well under the ~25K tool-result budget as the surface
  // grows.
  tools.push(
    server.registerTool(
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
      async ({ sections }) => ({
        content: [
          { type: "text", text: referencePreamble() },
          { type: "text", text: buildReferenceSections(sections) },
        ],
      }),
    ),
  );

  // The sandbox posts exactly one of these (see screenshot() in code.ts): `image`
  // (base64 PNG) on success, `errors` on the failure path — never both, never neither.
  const ScreenshotReply = z.union([
    z.object({ image: z.string() }),
    z.object({ errors: z.string() }),
  ]);

  tools.push(
    server.registerTool(
      "get_screenshot",
      {
        description: `Capture a PNG of what you've built so you can see it and self-correct.

Pass a nodeId (e.g. a frame's id returned from figma_execute_code) to screenshot just that node; omit it to snapshot the whole current page. Returns a PNG image.`,
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
        return {
          content: withSkewNote([{ type: "image", data: reply.image, mimeType: "image/png" }]),
        };
      },
    ),
  );

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
