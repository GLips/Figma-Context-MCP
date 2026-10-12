/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { MAX_SCREENSHOT_SCALE } from "@framelink/plugin/protocol";
import {
  screenshotInputError,
  type ScreenshotOptions,
} from "~/commercial/plugin-bridge/screenshot-options.js";
import { OutsideAssetRootError } from "~/commercial/plugin-bridge/contained-file.js";
import { startProgressHeartbeat, type ToolExtra } from "~/mcp/progress.js";
import { resolve as resolvePath } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  bindPluginAdvertisement,
  type PluginBridgeRuntime,
} from "~/commercial/plugin-bridge/index.js";
import { APPROVAL_WAIT_MS, ApprovalWaitError } from "~/commercial/plugin-bridge/await-approval.js";
import {
  approvalGuidance,
  pluginDisconnectedNotSubmittedText,
} from "~/commercial/plugin-bridge/blocked-call-guidance.js";
import {
  executePluginCode,
  capturePluginScreenshot,
} from "~/commercial/plugin-bridge/execution.js";
import { BridgeRequestError } from "~/commercial/plugin-bridge/bridge.js";
import type { ApprovedSession } from "~/commercial/plugin-bridge/approval-session.js";
import type { ServerExtension, ServerExtensionContext } from "~/mcp/index.js";
import { getFigmaDataTool } from "~/mcp/tools/index.js";
import { registerFramelinkTool, type FramelinkToolCall } from "~/mcp/framelink-tool.js";
import { retryableToolReply } from "~/mcp/fail-loud-params.js";
import type { ToolEventProperties } from "~/telemetry/index.js";
import { referenceSessionGuidance } from "~/commercial/plugin-bridge/session-guidance.js";
import { advertisePluginReadRoute, describePluginReadRecovery } from "./plugin-read-route.js";
import {
  buildQuickStart,
  buildReferenceMenu,
  buildReferenceSections,
} from "./flcm-docs/reference.js";
import { MCP_DOCS_CHANNEL } from "./flcm-docs/channels.js";
import { CLI_NAME } from "~/utils/cli-help.js";
import { formatExecuteCodeReply } from "./token-tree.js";

// The figma_execute_code description is the GENERATED quick-start (buildQuickStart), assembled from
// the schema single-source + narrative — so the agent-facing contract can't drift from the code
// (that drift once shipped a description of a deleted API). It is always inline in the tool
// description (not a separate resource) so it is ALWAYS in the agent's context when it writes code —
// the whole bet is that one tool + this contract beats dozens of granular tools. Full docs live in
// get_flcm_reference.
const EXECUTE_CODE_DESCRIPTION = buildQuickStart(MCP_DOCS_CHANNEL);

/**
 * The commercial write path as an extension of the MIT read server: the code-mode tools, plus the
 * plugin route get_figma_data's description and failures point at.
 */
export function codeModeExtension(
  runtime: PluginBridgeRuntime,
  { codeMode }: { codeMode: boolean },
): ServerExtension {
  return {
    describeReadRecovery: (error, request) => describePluginReadRecovery(runtime, error, request),
    register(server, context) {
      advertisePluginReadRoute(context.getFigmaData, runtime, {
        baseDescription: getFigmaDataTool.description,
        transport: context.transport,
      });
      registerCodeModeTools(server, runtime, { ...context, codeMode });
    },
  };
}

/**
 * What a write-path call reports. Codes and flags only: never the script, its reply or a message.
 * `figma_user_id` is the Authorizing User of the Allow that admitted the run (README: Telemetry).
 */
type CodeModeFacts = ToolEventProperties & {
  figma_user_id?: string;
  /** How far the call got. */
  outcome?: "executed" | "captured" | "pending_approval" | "refused" | "failed" | "not_run";
  /** A failure answered to the agent as a result — the plugin or the approval, never a bug. */
  failure?: string;
};

/** Who a run is attributed to: the Authorizing User of the Allow that admitted it. */
function admittedBy(session: ApprovedSession | null): CodeModeFacts {
  return session?.authorizingUser ? { figma_user_id: session.authorizingUser.figmaUserId } : {};
}

/**
 * The expected ways a plugin call ends without a reply, as a code — or null for anything else,
 * which is a bug and propagates.
 */
function expectedRunFailure(error: unknown, signal: AbortSignal): string | null {
  if (error instanceof BridgeRequestError) return `bridge_${error.outcome.replace("-", "_")}`;
  if (error instanceof ApprovalWaitError) return `approval_${error.reason}`;
  if (signal.aborted) return "cancelled";
  return null;
}

/**
 * Answer an expected failure as the result the SDK would have made of the throw — the same text —
 * so only a bug escapes the handler (and reaches error tracking as one). `failed`, not `not_run`: a
 * request lost after submission may have run.
 */
async function answeringExpectedFailures(
  call: FramelinkToolCall<CodeModeFacts>,
  extra: ToolExtra,
  facts: CodeModeFacts,
  run: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    const failure = expectedRunFailure(error, extra.signal);
    if (!failure) throw error;
    call.record({ ...facts, outcome: "failed", failure });
    return { isError: true, content: [{ type: "text", text: (error as Error).message }] };
  }
}

type CodeModeToolsOptions = Pick<
  ServerExtensionContext,
  "figmaService" | "transport" | "observe"
> & {
  /** Force the tools to be advertised from startup (`--code-mode`) instead of waiting for a plugin. */
  codeMode: boolean;
};

/**
 * Register the code-mode (write-path) tools: figma_execute_code, get_flcm_reference, get_screenshot.
 *
 * Dynamic exposure: the tools are registered but DISABLED until a plugin is connected or expected
 * (`bindPluginAdvertisement` over `pluginPresence()`), so the many read-only users of this server
 * never see write tools in tools/list. On stdio — a single long-lived connection — the first plugin connection enables them
 * live and the SDK emits notifications/tools/list_changed. On stateless HTTP every request builds a
 * fresh server, so the decision is simply re-read at construction time; there is no long-lived
 * connection to notify (GETs are 405'd — no SSE stream exists to carry a notification).
 * `--code-mode` forces always-on registration for list-caching clients that ignore list_changed.
 */
function registerCodeModeTools(
  server: McpServer,
  runtime: PluginBridgeRuntime,
  { codeMode, transport, figmaService, observe }: CodeModeToolsOptions,
): void {
  const { bridge } = runtime;

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
          () => approvalGuidance({ kind: "waiting", pairingCode: bridge.getPairingCode() }, "mcp"),
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
  function pendingApprovalResult(): { content: { type: "text"; text: string }[] } {
    return {
      content: [
        {
          type: "text",
          text: approvalGuidance(
            { kind: "expired", pairingCode: bridge.getPairingCode(), waitMs: APPROVAL_WAIT_MS },
            "mcp",
          ),
        },
      ],
    };
  }

  // Every code-mode tool fails loud on an unknown param: a mistyped param must come back as a named,
  // retryable error instead of being silently stripped (see fail-loud-params.ts).
  const tools = [
    registerFramelinkTool(
      server,
      {
        name: "figma_execute_code",
        unknownParams: "fail-loud",
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
              "Path to a .js file holding the same kind of script, read when the call arrives. Must be inside the server's asset root (the --asset-root directory, default the server's working directory); a relative path resolves against that root, so prefer an absolute path. Use it for long scripts: after an error, edit the file and resend only the path. " +
                `For a file outside the root, send it as code, or from a shell run \`npx ${CLI_NAME} execute <file>\`.`,
            ),
        },
        handler: async (
          { code, scriptPath }: { code?: string; scriptPath?: string },
          call: FramelinkToolCall<CodeModeFacts>,
          extra: ToolExtra,
        ) => {
          const source = { script_source: code === undefined ? "script_path" : "code" };
          call.record({ ...source, outcome: "not_run" });
          if (code !== undefined && scriptPath !== undefined) return scriptSourceReply("both");
          let script: string;
          if (code !== undefined) script = code;
          else if (scriptPath !== undefined) {
            try {
              script = await runtime.readSavedScript(scriptPath);
            } catch (error) {
              const { message, cause } = error as Error;
              // The server never widens what it reads (no roots, no path grants). An agent working
              // outside the root is sent to routes that already work; the CLI reads on the agent's
              // side. Its path is absolute because the CLI resolves against the shell's cwd.
              const remedy =
                cause instanceof OutsideAssetRootError
                  ? `send the script inline as code, or, with shell access, run ` +
                    `\`npx ${CLI_NAME} execute ${shellQuotedPath(resolvePath(cause.assetRoot, scriptPath))}\`, ` +
                    `which reads the file on your side with your own permissions (the CLI pairs ` +
                    `separately, so a human approves its pairing code in the Figma plugin)`
                  : "correct scriptPath, or send the script inline as code";
              call.record({ ...source, outcome: "not_run", failure: "script_unreadable" });
              return retryableToolReply(
                `figma_execute_code ${message}, so this call did not run. This is NOT a failure: ${remedy}.`,
              );
            }
          } else return scriptSourceReply("neither");
          const unavailable = pluginUnavailableReply();
          if (unavailable) return unavailable;
          return answeringExpectedFailures(call, extra, source, async () => {
            const outcome = await executePluginCode(runtime, script, approvalOptions(extra), {
              figma: figmaService,
            });
            if (outcome.kind === "refused") {
              call.record({ ...source, outcome: "refused", failure: outcome.refusal.reason });
              return { content: [{ type: "text", text: outcome.message }], isError: true };
            }
            if (outcome.kind === "pending") {
              call.record({ ...source, outcome: "pending_approval" });
              return pendingApprovalResult();
            }
            call.record({
              ...source,
              ...admittedBy(outcome.session),
              outcome: "executed",
              script_errored: outcome.reply.errors !== null,
            });
            return { content: [{ type: "text", text: formatExecuteCodeReply(outcome.reply) }] };
          });
        },
      },
      observe,
    ),

    // The full flcm authoring reference, delivered as a TOOL (not a resource): it can't fit the
    // figma_execute_code description, and MCP resources are user-gated / unevenly supported across clients.
    // A tool is the universal, autonomously-callable channel for shipping docs to agents. Sectioned because
    // the whole reference is far over one tool result's budget (REFERENCE_LIMIT_BYTES in reference.ts).
    registerFramelinkTool(
      server,
      {
        name: "get_flcm_reference",
        unknownParams: "fail-loud",
        description:
          "Full authoring reference for the `flcm` DSL used in figma_execute_code. Requires an array of " +
          'section ids (deduped, served in canonical order); start with ["mental-model"], which carries the ' +
          "identity, copying and session rules the rest assumes.",
        inputSchema: {
          // Optional, and plain strings rather than an enum of SECTION_IDS, so a blank call or a wrong id
          // reaches the handler: it serves the menu or an "Ignored unknown section … Valid: …" note. The
          // SDK's own fixed "Input validation error" names no sections and reads as a broken tool (see
          // fail-loud-params.ts).
          sections: z
            .array(z.string())
            .optional()
            // The menu lives here, always in context, because a successful call never returns it.
            .describe(
              'Required. Which sections to return, e.g. ["mental-model","props"]. The whole reference does not fit one response, so ask for the sections you need:\n' +
                buildReferenceMenu(),
            ),
        },
        handler: async (
          { sections }: { sections?: string[] },
          call: FramelinkToolCall<CodeModeFacts>,
        ) => {
          call.record({ section_count: sections?.length ?? 0 });
          // Docs still serve on a stale plugin — but lead with the refusal text so the agent learns
          // the re-import fix here, before its first (refused) write.
          const note = await referenceSessionGuidance({
            pairingCode: bridge.getPairingCode(),
            protocolRefusal: bridge.protocolRefusal(),
            status: (signal) => bridge.approvalStatus(signal),
          });
          return {
            content: [
              ...(note ? [{ type: "text" as const, text: note }] : []),
              { type: "text" as const, text: buildReferenceSections(sections, MCP_DOCS_CHANNEL) },
            ],
          };
        },
      },
      observe,
    ),

    registerFramelinkTool(
      server,
      {
        name: "get_screenshot",
        unknownParams: "fail-loud",
        description: `Capture a PNG of what you've built so you can see it and self-correct. Build → screenshot → look → fix.

Target ONE node, or omit both targets to snapshot the whole current page:
- nodeId — a node's id. Copy it from a figma_execute_code result: \`(await flcm.render(tree)).id\`, or a child's \`.id\` in the returned tree.
- key — a key you authored on a node (\`{ type: "FRAME", key: "card" }\`). An unknown key, or one matching several nodes (duplicating a node copies its key), fails loud rather than guessing.

Passing both nodeId and key is ambiguous and fails loud. A failed lookup NEVER falls back to the whole page.

scale (default 1, max ${MAX_SCREENSHOT_SCALE}) multiplies the export resolution — use scale: 2–4 to inspect detail you can't resolve at 1x: hairline borders, 1px strokes, grain, glass refraction, small type.

context:true also captures the canvas around the target, to check how it sits among its neighbours; it needs nodeId or key. margin is the pixels added on each side (default 10% of the target's longest side, clamped to 80–160).

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
        handler: async (
          target: ScreenshotOptions,
          call: FramelinkToolCall<CodeModeFacts>,
          extra: ToolExtra,
        ) => {
          call.record({ outcome: "not_run" });
          // Known params are type-checked by the SDK; their value-level misuse is checked here, in
          // the same retryable shape as an unknown param, so the agent fixes the call and retries.
          const inputError = screenshotInputError(target);
          if (inputError) {
            call.reject({ field: "(root)", rule: "screenshot_target" });
            return retryableToolReply(
              `get_screenshot: ${inputError} This is NOT a failure: correct the arguments and retry.`,
            );
          }
          const unavailable = pluginUnavailableReply();
          if (unavailable) return unavailable;
          return answeringExpectedFailures(call, extra, {}, async () => {
            const outcome = await capturePluginScreenshot(bridge, target, approvalOptions(extra));
            if (outcome.kind === "pending") {
              call.record({ outcome: "pending_approval" });
              return pendingApprovalResult();
            }
            const reply = outcome.reply;
            const failed = "errors" in reply;
            call.record({
              ...admittedBy(outcome.session),
              outcome: "captured",
              failure: failed ? "screenshot_failed" : undefined,
            });
            if (failed) return { content: [{ type: "text", text: reply.errors }], isError: true };
            return { content: [{ type: "image", data: reply.image, mimeType: "image/png" }] };
          });
        },
      },
      observe,
    ),
  ];

  // Advertised whenever a plugin is connected OR expected — NOT only once one has connected in this
  // process. The narrower rule made a dev-watch restart look like a cold start: for the seconds before
  // the plugin redialed, a stateless-HTTP request built a server with the write tools disabled and the
  // call came back "Tool figma_execute_code disabled" — a hard MCP error (-32602) with no path
  // forward. A hidden tool has no handler in which to say anything better.
  if (codeMode) return;
  // disable() before the transport connects is a silent flag flip (the SDK skips the list_changed
  // notification when disconnected), so clients never see a flap.
  bindPluginAdvertisement(runtime, transport, (expected) => {
    for (const tool of tools) {
      if (expected) tool.enable();
      else tool.disable();
    }
  });
}

/** Leaves an ordinary path bare so the suggested command reads cleanly; quotes anything a shell would split. */
function shellQuotedPath(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
}
