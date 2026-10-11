/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { MAX_SCREENSHOT_SCALE } from "~/commercial/plugin-bridge/screenshot-options.js";
import { startProgressHeartbeat, type ToolExtra } from "~/mcp/progress.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { PluginBridgeRuntime } from "~/commercial/plugin-bridge/index.js";
import { APPROVAL_WAIT_MS, isPendingApproval } from "~/commercial/plugin-bridge/await-approval.js";
import {
  approvalPendingAction,
  pluginDisconnectedNotSubmittedText,
} from "~/commercial/plugin-bridge/blocked-call-guidance.js";
import {
  executePluginCode,
  capturePluginScreenshot,
} from "~/commercial/plugin-bridge/execution.js";
import type { ServerTransport } from "~/mcp/index.js";
import type { FigmaService } from "~/services/figma.js";
import { registerFailLoudTool, retryableToolReply } from "~/mcp/fail-loud-params.js";
import { referenceSessionGuidance } from "./flcm-docs/session-guidance.js";
import {
  buildQuickStart,
  buildReferenceMenu,
  buildReferenceSections,
  SECTION_IDS,
} from "./flcm-docs/reference.js";
import { MCP_DOCS_CHANNEL } from "./flcm-docs/channels.js";

// The figma_execute_code description is the GENERATED quick-start (buildQuickStart), assembled from
// the schema single-source + narrative — so the agent-facing contract can't drift from the code
// (that drift once shipped a description of a deleted API). It is always inline in the tool
// description (not a separate resource) so it is ALWAYS in the agent's context when it writes code —
// the whole bet is that one tool + this contract beats dozens of granular tools. Full docs live in
// get_flcm_reference.
const EXECUTE_CODE_DESCRIPTION = buildQuickStart(MCP_DOCS_CHANNEL);

type CodeModeToolsOptions = {
  /** Force the tools to be advertised from startup (`--code-mode`) instead of waiting for a plugin. */
  codeMode: boolean;
  /** This MCP request's Figma client. A run's mid-run Figma fetches (comment counts) spend its token. */
  figmaService: FigmaService;
  transport: ServerTransport;
};

/**
 * Register the code-mode (write-path) tools: figma_execute_code, get_flcm_reference, get_screenshot.
 *
 * Dynamic exposure: the tools are registered but DISABLED until a plugin is connected or expected
 * (expectsPluginConnection), so the many read-only users of this server never see write tools in
 * tools/list. On stdio — a single long-lived connection — the first plugin connection enables them
 * live and the SDK emits notifications/tools/list_changed. On stateless HTTP every request builds a
 * fresh server, so the decision is simply re-read at construction time; there is no long-lived
 * connection to notify (GETs are 405'd — no SSE stream exists to carry a notification).
 * `--code-mode` forces always-on registration for list-caching clients that ignore list_changed.
 */
export function registerCodeModeTools(
  server: McpServer,
  runtime: PluginBridgeRuntime,
  { codeMode, transport, figmaService }: CodeModeToolsOptions,
): void {
  const { bridge } = runtime;

  /** Tool advertisement stays latched for this process; outage guidance uses elapsed time below. */
  function expectsPluginConnection(): boolean {
    return runtime.hasEverConnected() || bridge.hasRecentApproval();
  }

  /** A pre-submission outage uses bounded reconnect guidance; in-flight errors come from the bridge. */
  function pluginUnavailableReply(): CallToolResult | null {
    if (bridge.isPluginConnected()) return null;
    return retryableToolReply(pluginDisconnectedNotSubmittedText(bridge.disconnectedDurationMs()));
  }

  function approvalOptions(extra: ToolExtra) {
    return {
      signal: extra.signal,
      onWaiting: () =>
        startProgressHeartbeat(
          extra,
          () =>
            `Waiting for approval in Figma (pairing code ${bridge.getPairingCode()}). Code has not been submitted.`,
          3000,
        ),
    };
  }

  function scriptSourceReply(got: "neither" | "both"): CallToolResult {
    return retryableToolReply(
      `figma_execute_code needs exactly one of code or scriptPath, and got ${got}, so this call did ` +
        `not run. This is NOT a failure: retry with one of them.`,
    );
  }

  /** A gate refusal proves the submitted body did not execute, including approval revoked after polling. */
  function gateResult(reply: unknown): { content: { type: "text"; text: string }[] } | null {
    if (!isPendingApproval(reply)) return null;
    return {
      content: [
        {
          type: "text",
          text: `This call did not run. ${approvalPendingAction(bridge.getPairingCode(), APPROVAL_WAIT_MS)}`,
        },
      ],
    };
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
          // Both optional at the wire so a call with neither or both reaches the handler's named,
          // retryable refusal instead of the SDK's fixed validation error (see fail-loud-params.ts).
          code: z
            .string()
            .optional()
            .describe(
              "JavaScript to run in the Figma sandbox. Runs in an async body; use await freely; return a value. Pass code or scriptPath, not both.",
            ),
          scriptPath: z
            .string()
            .optional()
            .describe(
              "Path to a .js file holding the same kind of script, read when the call arrives. Must be inside the server's asset root (the --asset-root directory, default the server's working directory); a relative path resolves against that root, so prefer an absolute path. Use it for long scripts: after an error, edit the file and resend only the path.",
            ),
        },
      },
      async ({ code, scriptPath }, extra) => {
        if (code !== undefined && scriptPath !== undefined) return scriptSourceReply("both");
        let script: string;
        if (code !== undefined) script = code;
        else if (scriptPath !== undefined) {
          try {
            script = await runtime.readSavedScript(scriptPath);
          } catch (error) {
            return retryableToolReply(
              `figma_execute_code ${(error as Error).message}, so this call did not run. Fix the ` +
                `path and retry.`,
            );
          }
        } else return scriptSourceReply("neither");
        const unavailable = pluginUnavailableReply();
        if (unavailable) return unavailable;
        const outcome = await executePluginCode(runtime, script, approvalOptions(extra), {
          figma: figmaService,
        });
        if (outcome.kind === "refused")
          return { content: [{ type: "text", text: outcome.message }], isError: true };
        if (outcome.kind === "pending") return gateResult({ type: "PENDING_APPROVAL" })!;
        return { content: [{ type: "text", text: JSON.stringify(outcome.reply, null, 2) }] };
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
          "Full authoring reference for the `flcm` DSL used in figma_execute_code. Requires an array of " +
          'section ids (deduped, served in canonical order); start with ["mental-model"], which carries the ' +
          "identity, copying and session rules the rest assumes.",
        inputSchema: {
          // Optional at the wire so a blank call reaches the handler and gets the section menu back. A
          // required zod field would make the SDK answer with its own fixed "Input validation error",
          // which names no sections and reads as a broken tool (see fail-loud-params.ts).
          sections: z
            .array(z.enum(SECTION_IDS))
            .optional()
            // The menu lives here, always in context, because a successful call never returns it.
            .describe(
              'Required. Which sections to return, e.g. ["mental-model","props"]. The whole reference does not fit one response, so ask for the sections you need:\n' +
                buildReferenceMenu(),
            ),
        },
      },
      async ({ sections }) => {
        // Docs still serve on a stale plugin — but lead with the refusal text so the agent learns
        // the re-import fix here, before its first (refused) write.
        const note = await referenceSessionGuidance({
          pairingCode: bridge.getPairingCode(),
          protocolRefusal: bridge.protocolRefusal(),
          status: (signal) => bridge.request({ type: "APPROVAL_STATUS" }, signal),
        });
        return {
          content: [
            ...(note ? [{ type: "text" as const, text: note }] : []),
            { type: "text" as const, text: buildReferenceSections(sections, MCP_DOCS_CHANNEL) },
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
- nodeId — a node's id. Copy it from a figma_execute_code result: \`(await flcm.render(tree)).id\`, or a child's \`.id\` in the returned tree.
- key — a key you authored on a node (\`{ type: "FRAME", key: "card" }\`). An unknown key, or one matching several nodes (duplicating a node copies its key), fails loud rather than guessing.

Passing both nodeId and key is ambiguous and fails loud. A failed lookup NEVER falls back to the whole page.

scale (default 1, max 4) multiplies the export resolution — use scale: 2–4 to inspect detail you can't resolve at 1x: hairline borders, 1px strokes, grain, glass refraction, small type.

context:true also captures the canvas around the target, to check how it sits among its neighbours; it needs nodeId or key. margin is the pixels added on each side (default 10% of the target's longest side, clamped to 24–160).

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
          context: z
            .boolean()
            .optional()
            .describe("Also capture the canvas around the target. Needs nodeId or key."),
          margin: z
            .number()
            .optional()
            .describe("Pixels of surrounding canvas on each side; needs context:true."),
          scale: z
            .number()
            .optional()
            .describe(
              `Export resolution multiplier, greater than 0 and at most ${MAX_SCREENSHOT_SCALE} (default 1). Raise it to inspect fine detail.`,
            ),
        },
      },
      async ({ nodeId, key, scale, context, margin }, extra) => {
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
        if (context && nodeId === undefined && key === undefined)
          return retryableToolReply("Contextual capture requires nodeId or key.");
        if (margin !== undefined && (!context || !Number.isFinite(margin) || margin < 0))
          return retryableToolReply(
            "margin requires context:true and a finite nonnegative pixel value.",
          );
        const unavailable = pluginUnavailableReply();
        if (unavailable) return unavailable;
        const outcome = await capturePluginScreenshot(
          bridge,
          { nodeId, key, scale, context, margin },
          approvalOptions(extra),
        );
        if (outcome.kind === "pending") return gateResult({ type: "PENDING_APPROVAL" })!;
        const reply = outcome.reply;
        if ("errors" in reply) {
          return { content: [{ type: "text", text: reply.errors }], isError: true };
        }
        if (context && reply.capture !== "contextual")
          return {
            content: [
              {
                type: "text",
                text: "Connected plugin does not support contextual capture. Rebuild and reopen the updated plugin; this isolated response was discarded.",
              },
            ],
            isError: true,
          };
        return {
          content: [{ type: "image", data: reply.image, mimeType: "image/png" }],
        };
      },
    ),
  ];

  // Advertised whenever a plugin is connected OR expected — NOT only once one has connected in this
  // process. The narrower rule made a dev-watch restart look like a cold start: for the seconds before
  // the plugin redialed, a stateless-HTTP request built a server with the write tools disabled and the
  // call came back "Tool figma_execute_code disabled" — a hard MCP error (-32602) with no path
  // forward. That is strictly worse than a slow answer: an agent told the capability does not exist
  // stops trying, and cannot know that a retry would have worked. A hidden tool also has no handler in
  // which to say anything better, which is why this decision has to come first.
  if (codeMode || expectsPluginConnection()) return;

  // Hidden until a plugin proves the write path exists. disable() before the transport connects is
  // a silent flag flip (the SDK skips the list_changed notification when disconnected), so clients
  // never see a flap. Only stdio subscribes to the latch: its one server outlives the whole session,
  // while stateless HTTP builds a fresh server per request — each request re-reads the decision above,
  // and subscribing those short-lived servers would accumulate dead closures until first connect.
  // (Stdio also registers before the relay has finished binding, so `hasRecentApproval` is still
  // false here for it — the latch subscription below is what enables its tools either way.)
  for (const tool of tools) tool.disable();
  if (transport === "stdio") {
    runtime.onFirstConnect(() => {
      for (const tool of tools) tool.enable();
    });
  }
}
