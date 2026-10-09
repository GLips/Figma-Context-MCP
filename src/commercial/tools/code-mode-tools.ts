/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { startProgressHeartbeat, type ToolExtra } from "~/mcp/progress.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PluginBridgeRuntime } from "~/commercial/plugin-bridge/index.js";
import { BridgeRequestError } from "~/commercial/plugin-bridge/bridge.js";
import {
  writeRefusalText,
  type WriteAuthorization,
} from "~/commercial/entitlement/write-authorization.js";
import {
  requestUntilApproved,
  isPendingApproval,
} from "~/commercial/plugin-bridge/await-approval.js";
import type { ServerTransport } from "~/mcp/index.js";
import type { FigmaService } from "~/services/figma.js";
import { registerFailLoudTool, retryableToolReply } from "~/mcp/fail-loud-params.js";
import { flcmSandboxPreamble } from "~/commercial/plugin-bridge/sandbox-preamble.js";
import { referenceSessionGuidance } from "./flcm-docs/session-guidance.js";
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
// (PluginBridge.serveChannelRequest), so a script executes exactly once and this reply is the
// whole story — no re-run signals, no second pass.
//
// `documentChanged` is whether the document changed while the run executed — raw figma.* writes
// included, and writes that landed after the agent's code returned. True is one Write against the
// free allowance. False is provisional: a change Figma reports later arrives as RUN_CHANGED. It is
// the server's to read, not the agent's, so it never reaches the tool result.
const ExecuteCodeReply = z.object({
  result: z.unknown().optional(),
  console: z.array(z.string()),
  errors: z.string().nullable(),
  documentChanged: z.boolean(),
});

// The sandbox posts exactly one of these (see screenshot() in code.ts): `image`
// (base64 PNG) on success, `errors` on the failure path — never both, never neither.
const ScreenshotReply = z.union([
  z.object({ image: z.string(), capture: z.literal("contextual").optional() }),
  z.object({ errors: z.string() }),
]);

// Upper cap on the screenshot export scale, so a fat-fingered `scale: 40` can't ask Figma to export a
// page-sized PNG at absurd resolution (and blow the agent's image budget on the way back). 4x already
// resolves hairlines and grain, and matches the top of Figma's own export-scale UI.
const MAX_SCREENSHOT_SCALE = 4;

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
  const { bridge, writeAccess } = runtime;

  /** Tool advertisement stays latched for this process; outage guidance uses elapsed time below. */
  function expectsPluginConnection(): boolean {
    return runtime.hasEverConnected() || bridge.hasRecentApproval();
  }

  /** A pre-submission outage uses bounded reconnect guidance; in-flight errors come from the bridge. */
  function pluginUnavailableReply(): CallToolResult | null {
    if (bridge.isPluginConnected()) return null;
    const elapsed = bridge.disconnectedDurationMs();
    if (elapsed !== null && elapsed < 30_000) {
      return retryableToolReply(
        `The Figma plugin disconnected ${Math.round(elapsed / 1000)}s ago. This call was not submitted. Allow a few seconds for reconnection, then retry once.`,
      );
    }
    return retryableToolReply(
      `No Figma plugin is connected. This call was not submitted. Check that the Framelink plugin is open in the intended Figma file and the local server is running, then retry.`,
    );
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

  /** A gate refusal proves the submitted body did not execute, including approval revoked after polling. */
  function gateResult(reply: unknown): { content: { type: "text"; text: string }[] } | null {
    if (!isPendingApproval(reply)) return null;
    const code = bridge.getPairingCode();
    return {
      content: [
        {
          type: "text",
          text: `Session approval was unavailable, so this call did not execute. In Figma, approve pairing code ${code}, then submit a new call. This finished call will not run after a later Allow.`,
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
          code: z
            .string()
            .describe(
              "JavaScript to run in the Figma sandbox. Runs in an async body; use await freely; return a value.",
            ),
        },
      },
      async ({ code }, extra) => {
        const unavailable = pluginUnavailableReply();
        if (unavailable) return unavailable;
        // One execution, one id: this is the identity the free allowance dedupes on. A new tool call
        // is a new execution even when the code is identical.
        const executionId = randomUUID();
        // Set inside submit (a closure), so held in an object the checks below can read. `runId` is
        // the plugin's name for this execution, which a late RUN_CHANGED will carry.
        const gate: { authorization: WriteAuthorization | null; runId: string | null } = {
          authorization: null,
          runId: null,
        };
        // Correlation ids are owned by PluginBridge; mid-run image fetches ride the bridge underneath
        // this single execute (serveChannelRequest). The wait holds the call open across the human's
        // Allow rather than returning "not approved yet" for the agent to retry — see
        // requestUntilApproved.
        //
        // The flcm std-lib rides along on EVERY call (ADR-0010): the plugin holds no runtime of its
        // own, so this field IS the DSL the code runs against. Sent every time rather than cached by
        // hash — the sandbox already re-evals the whole string per call, so it costs transfer only,
        // and a preamble sent every time is definitionally the one that ran, leaving no drift to
        // detect and nothing to put in the version handshake.
        //
        // The write gate sits INSIDE submit, after approval: the Authorizing User is whoever clicked
        // Allow, which may happen during the wait. An execution can't be known to change the document
        // before it runs, so an Authorizing User with no seat and no allowance left is refused before
        // anything is sent — and an authorized one holds a reservation until the finally below.
        try {
          let raw: unknown;
          try {
            raw = await requestUntilApproved(
              (signal) => bridge.request({ type: "APPROVAL_STATUS" }, signal),
              async (signal) => {
                gate.authorization = await writeAccess.authorizeWriteExecution(
                  bridge.getAuthorizingUser(),
                  executionId,
                );
                if (gate.authorization.kind === "refused") return null;
                return bridge.request(
                  { type: "EXECUTE_CODE", code, preamble: flcmSandboxPreamble() },
                  signal,
                  (runId) => (gate.runId = runId),
                  { figma: figmaService },
                );
              },
              approvalOptions(extra),
            );
          } catch (err) {
            // Lost after the plugin may have started it (timeout, cancel, disconnect): whether it
            // changed anything is unknowable, and partial changes count, so it is counted. Only a
            // run the plugin reported QUEUED is known not to have run — the plugin refuses a
            // cancelled queued run at dequeue — and a result it sends anyway is still counted
            // through the late path.
            if (
              gate.authorization &&
              err instanceof BridgeRequestError &&
              err.outcome === "unconfirmed" &&
              err.phase !== "queued"
            )
              writeAccess.recordWriteExecution(gate.authorization, executionId);
            throw err;
          }
          const { authorization } = gate;
          if (authorization?.kind === "refused")
            return {
              content: [
                {
                  type: "text",
                  text: writeRefusalText(authorization, writeAccess.framelinkApiUrl),
                },
              ],
              isError: true,
            };
          const gated = gateResult(raw);
          if (gated) return gated;
          const { documentChanged, ...reply } = ExecuteCodeReply.parse(raw);
          if (documentChanged && authorization)
            writeAccess.recordWriteExecution(authorization, executionId);
          // A write actually ran: slide the persisted approval's TTL forward so an active session
          // never lapses mid-work (durable-approval, this cycle). No-op when the session isn't persisted.
          bridge.touchApproval();
          return {
            content: [{ type: "text", text: JSON.stringify(reply, null, 2) }],
          };
        } finally {
          // Whatever wasn't recorded above ends here; a change the plugin reports later under
          // `runId` is still charged to this execution (WriteAccess.recordLateDocumentChange).
          writeAccess.releaseWriteExecution(executionId, gate.runId);
        }
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
          "identity, copying and session rules the rest assumes. Sections: " +
          SECTION_IDS.join(", ") +
          ".",
        inputSchema: {
          // Optional at the wire so a blank call reaches the handler and gets the section menu back. A
          // required zod field would make the SDK answer with its own fixed "Input validation error",
          // which names no sections and reads as a broken tool (see fail-loud-params.ts).
          sections: z
            .array(z.enum(SECTION_IDS))
            .optional()
            .describe(
              'Required. Which sections to return, e.g. ["mental-model","props"]. The whole reference does not fit one response, so ask for the sections you need; a call naming none is refused with the list of ids.',
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
- nodeId — a node's id. Copy it from a figma_execute_code result: \`(await flcm.render(tree)).id\`, or a child's \`.id\` in the returned tree.
- key — a key you authored on a node (\`{ type: "FRAME", key: "card" }\`). An unknown key, or one matching several nodes (duplicating a node copies its key), fails loud rather than guessing.

Passing both nodeId and key is ambiguous and fails loud. A failed lookup NEVER falls back to the whole page.

scale (default 1, max 4) multiplies the export resolution — use scale: 2–4 to inspect detail you can't resolve at 1x: hairline borders, 1px strokes, grain, glass refraction, small type.

context:true opts into a temporary-slice prototype that captures surrounding canvas. Requires nodeId or key. margin is pixels on each side; provisional default is 10% of the longest target side, clamped to 24–160px. Selection, flicker, undo and visual fidelity remain unverified. Omit context for the existing isolated capture.

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
            .describe("Opt-in contextual capture prototype using a temporary canvas slice."),
          margin: z
            .number()
            .optional()
            .describe("Nonnegative context margin in pixels; requires context:true."),
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
        const raw = await requestUntilApproved(
          (signal) => bridge.request({ type: "APPROVAL_STATUS" }, signal),
          (signal) =>
            bridge.request({ type: "SCREENSHOT", nodeId, key, scale, context, margin }, signal),
          approvalOptions(extra),
        );
        const gated = gateResult(raw);
        if (gated) return gated;
        const reply = ScreenshotReply.parse(raw);
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
