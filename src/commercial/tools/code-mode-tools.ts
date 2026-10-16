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
  type PluginPresenceSource,
} from "~/commercial/plugin-bridge/index.js";
import { GRANT_WAIT_MS } from "~/commercial/plugin-bridge/call-target.js";
import {
  GRANT_WAITING_TEXT,
  notGrantedText,
  pairingCodeUnknownText,
  sessionNotFoundText,
} from "~/commercial/plugin-bridge/blocked-call-guidance.js";
import {
  executePluginCode,
  capturePluginScreenshot,
  type PluginCallTarget,
} from "~/commercial/plugin-bridge/execution.js";
import {
  BridgeRequestError,
  type CallDocument,
  type PluginLink,
} from "~/commercial/plugin-bridge/bridge.js";
import { documentReaderFor } from "~/commercial/plugin-bridge/link-documents.js";
import { parseFigmaFileKey, type FigmaFileKey } from "~/utils/figma-url.js";
import {
  parseSessionHandle,
  type SessionHandle,
} from "~/commercial/plugin-bridge/session-handle.js";
import type { CallTargetRequest } from "~/commercial/plugin-bridge/call-target.js";
import type { CallerContext, ServerExtension, ServerExtensionContext } from "~/mcp/index.js";
import { getFigmaDataTool } from "~/mcp/tools/index.js";
import { registerFramelinkTool, type FramelinkToolCall } from "~/mcp/framelink-tool.js";
import { retryableToolReply } from "~/mcp/fail-loud-params.js";
import type { ToolEventProperties } from "~/telemetry/index.js";
import { referenceGrantNote } from "~/commercial/plugin-bridge/reference-grant-guidance.js";
import { advertisePluginReadRoute, describePluginReadRecovery } from "./plugin-read-route.js";
import {
  buildQuickStart,
  buildReferenceMenu,
  buildReferenceSections,
} from "./flcm-docs/reference.js";
import { MCP_DOCS_CHANNEL } from "./flcm-docs/channels.js";
import { CLI_NAME } from "~/utils/cli-help.js";
import { formatExecuteCodeReply } from "./token-tree.js";
import {
  PAIRING_GUIDANCE_MIN_LIFE_MS,
  pairPluginLink,
  targetForPluginCall,
  type PairingCodeAsker,
  type PluginCallTargeting,
} from "~/commercial/plugin-bridge/plugin-call-link.js";

// The figma_execute_code description is the GENERATED quick-start (buildQuickStart), assembled from
// the schema single-source + narrative — so the agent-facing contract can't drift from the code
// (that drift once shipped a description of a deleted API). It is always inline in the tool
// description (not a separate resource) so it is ALWAYS in the agent's context when it writes code —
// the whole bet is that one tool + this contract beats dozens of granular tools. Full docs live in
// get_flcm_reference.
const EXECUTE_CODE_DESCRIPTION = buildQuickStart(MCP_DOCS_CHANNEL);

/** The caller context the write path reads: the read grants plus the operator's plugin. */
export interface CodeModeCallerContext extends CallerContext {
  /**
   * The operator's plugin relay, with the asset root it reads scripts and images under. Null
   * refuses figma_execute_code and get_screenshot when called.
   */
  plugin: PluginBridgeRuntime | null;
}

// A permanent boundary, not a missing feature: the plugin, its grants and the asset root are the
// operator's, and a remote caller is by definition someone else. Shared writes are the hosted service's.
const LOCAL_WRITES_NEED_LOOPBACK =
  "Local writes need a loopback server. This server listens on a network address, so it gives " +
  "remote callers none of its operator's plugin, files or Figma token, and this call did not run. " +
  "To edit Figma, run Framelink on the machine where Figma is open, bound to 127.0.0.1 (the default).";

/**
 * The commercial write path as an extension of the MIT read server: the code-mode tools, plus the
 * plugin route get_figma_data's description and failures point at. `presence` only decides what is
 * advertised; every use of the plugin goes through the caller's own grant.
 */
export function codeModeExtension(
  presence: PluginPresenceSource,
  { codeMode }: { codeMode: boolean },
): ServerExtension<CodeModeCallerContext> {
  return {
    describeReadRecovery: ({ plugin }) =>
      plugin && ((error, request) => describePluginReadRecovery(plugin, error, request)),
    register(server, context) {
      // A remote caller can't use the plugin, so get_figma_data mustn't point it there.
      if (context.caller.plugin)
        advertisePluginReadRoute(context.getFigmaData, presence, {
          baseDescription: getFigmaDataTool.description,
          transport: context.transport,
        });
      registerCodeModeTools(server, presence, { ...context, codeMode });
    },
  };
}

/**
 * What a write-path call reports. Codes and flags only: never the script, its reply or a message.
 * `figma_user_id` is the Figma user the run's plugin link is signed in as (README: Telemetry).
 */
type CodeModeFacts = ToolEventProperties & {
  figma_user_id?: string;
  /** How far the call got. */
  outcome?: "executed" | "captured" | "paired" | "refused" | "failed" | "not_run";
  /** A failure answered to the agent as a result — the plugin or its grant, never a bug. */
  failure?: string;
};

/** Who a run is attributed to: the Figma user its plugin link is signed in as. */
function ownedBy(link: PluginLink): CodeModeFacts {
  return link.owner ? { figma_user_id: link.owner.figmaUserId } : {};
}

/**
 * The expected ways a plugin call ends without a reply, as a code — or null for anything else,
 * which is a bug and propagates.
 */
function expectedRunFailure(error: unknown, signal: AbortSignal): string | null {
  if (error instanceof BridgeRequestError) return `bridge_${error.outcome.replace("-", "_")}`;
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
  ServerExtensionContext<CodeModeCallerContext>,
  "caller" | "figmaService" | "transport" | "observe"
> & {
  /** Force the tools to be advertised from startup (`--code-mode`) instead of waiting for a plugin. */
  codeMode: boolean;
};

/**
 * Register the code-mode (write-path) tools: figma_execute_code, get_flcm_reference, get_screenshot,
 * pair_figma_plugin.
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
  presence: PluginPresenceSource,
  { codeMode, transport, caller, figmaService, observe }: CodeModeToolsOptions,
): void {
  const runtime = caller.plugin;

  /**
   * The client's own prompt for confirming a pairing code, when it advertises form elicitation.
   * Stateless HTTP never does: it has no session to carry the client's capabilities.
   */
  function pairingCodeAsker(extra: ToolExtra): PairingCodeAsker | null {
    if (!server.server.getClientCapabilities()?.elicitation?.form) return null;
    return async (code, expiresInMs, signal) => {
      // A client that advertises prompts but never answers must hand back while the code still has
      // time for the agent to ask instead.
      const timeout = Math.min(PAIRING_PROMPT_MAX_MS, expiresInMs - PAIRING_GUIDANCE_MIN_LIFE_MS);
      if (timeout <= 0) return "unanswered";
      try {
        const answer = await server.server.elicitInput(
          {
            mode: "form",
            message:
              `Pair with the Framelink plugin? Check the Framelink plugin panel in Figma: it should ` +
              `show the pairing code ${code}. Answer yes only if it shows exactly this code — ` +
              `pairing lets this server edit your Figma files.`,
            requestedSchema: {
              type: "object",
              properties: {
                shown: { type: "boolean", title: `The panel shows ${code}`, default: false },
              },
              required: ["shown"],
            },
          },
          { signal, timeout, relatedRequestId: extra.requestId },
        );
        if (answer.action === "decline") return "not-shown";
        if (answer.action === "accept")
          return answer.content?.shown === true ? "shown" : "not-shown";
        return "unanswered";
      } catch (error) {
        if (signal.aborted) throw error;
        return "unanswered";
      }
    };
  }

  /**
   * Where the call runs — its document and link, granted — or the reply that explains why it runs
   * nowhere. Prompts in the plugin while it waits; submits nothing.
   */
  async function pluginCallTarget(
    { bridge }: PluginBridgeRuntime,
    call: FramelinkToolCall<CodeModeFacts>,
    facts: CodeModeFacts,
    extra: ToolExtra,
    { fileKey, session }: CallTargetRequest,
  ): Promise<PluginCallTarget | { reply: CallToolResult }> {
    const targeted = await targetForPluginCall(bridge, {
      fileKey,
      session,
      pairing: { kind: "offer", ask: pairingCodeAsker(extra) },
      signal: extra.signal,
      surface: "mcp",
      reader: documentReaderFor(figmaService),
      waitMs: GRANT_WAIT_MS,
      onWaiting: () => startProgressHeartbeat(extra, () => GRANT_WAITING_TEXT, 3000),
    });
    if (targeted.kind === "targeted") return targeted;
    return { reply: blockedCallReply(call, facts, targeted) };
  }

  function scriptSourceReply(got: "neither" | "both"): CallToolResult {
    return retryableToolReply(
      `figma_execute_code needs exactly one of code or scriptPath, and got ${got}, so this call did ` +
        `not run. This is NOT a failure: retry with one of them.`,
    );
  }

  /** The plugin refused a bound call on arrival: its grant was revoked, or it left the file. */
  function notGrantedReply(
    call: FramelinkToolCall<CodeModeFacts>,
    facts: CodeModeFacts,
    target: PluginCallTarget,
    reason: "no-grant" | "other-document",
  ): CallToolResult {
    call.record({
      ...facts,
      ...ownedBy(target.link),
      outcome: "refused",
      failure: `not_granted_${reason.replace("-", "_")}`,
    });
    return {
      isError: true,
      content: [{ type: "text", text: notGrantedText(reason, target.document.fileName) }],
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
          fileKey: FILE_KEY_PARAM,
          session: z
            .string()
            .optional()
            .describe(
              "The session handle a previous figma_execute_code reply named (four words, e.g. maple-orbit-velvet-quarry), to keep that call's `session` values and session.last. The call runs in the file that session is in. Omit to start a fresh session; every reply names the handle of the session it used.",
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
          {
            code,
            scriptPath,
            fileKey,
            session,
          }: { code?: string; scriptPath?: string; fileKey?: string; session?: string },
          call: FramelinkToolCall<CodeModeFacts>,
          extra: ToolExtra,
        ) => {
          const source = { script_source: code === undefined ? "script_path" : "code" };
          // Before scriptPath is read: the asset root is part of the grant.
          if (!runtime) {
            call.record({ ...source, outcome: "refused", failure: "remote_caller" });
            return localWritesRefusal();
          }
          call.record({ ...source, outcome: "not_run" });
          if (code !== undefined && scriptPath !== undefined) return scriptSourceReply("both");
          const targetFileKey = fileKeyParam(fileKey);
          if (targetFileKey === "invalid") return fileKeyReply();
          const targetSession = sessionParam(session);
          if (targetSession === "invalid") return sessionReply();
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
                    `which reads the file on your side with your own permissions (a human allows ` +
                    `this project in the Figma plugin)`
                  : "correct scriptPath, or send the script inline as code";
              call.record({ ...source, outcome: "not_run", failure: "script_unreadable" });
              return retryableToolReply(
                `figma_execute_code ${message}, so this call did not run. This is NOT a failure: ${remedy}.`,
              );
            }
          } else return scriptSourceReply("neither");
          return answeringExpectedFailures(call, extra, source, async () => {
            const target = await pluginCallTarget(runtime, call, source, extra, {
              fileKey: targetFileKey,
              session: targetSession,
            });
            if ("reply" in target) return target.reply;
            const { link } = target;
            const outcome = await executePluginCode(runtime, target, script, {
              figma: figmaService,
              signal: extra.signal,
            });
            if (outcome.kind === "not-granted")
              return notGrantedReply(call, source, target, outcome.reason);
            if (outcome.kind === "session-not-found") {
              call.record({ ...source, outcome: "not_run", failure: "session_not_found" });
              return {
                isError: true,
                content: [{ type: "text", text: sessionNotFoundText(outcome.session, "mcp") }],
              };
            }
            if (outcome.kind === "refused") {
              call.record({
                ...source,
                ...ownedBy(link),
                outcome: "refused",
                failure: outcome.refusal.reason,
              });
              return { content: [{ type: "text", text: outcome.message }], isError: true };
            }
            call.record({
              ...source,
              ...ownedBy(link),
              outcome: "executed",
              script_errored: outcome.reply.errors !== null,
            });
            return {
              content: [
                {
                  type: "text",
                  text: [
                    ranIn(target.document),
                    usedSession(outcome.session),
                    formatExecuteCodeReply(outcome.reply),
                  ].join("\n"),
                },
              ],
            };
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
          // Docs still serve on a stale or unpaired plugin — but lead with what blocks a write, so the
          // agent learns the fix here, before its first refused write. The link is the operator's: a
          // caller without the plugin grant learns nothing of it.
          const note = runtime && (await referenceGrantNote(runtime.bridge));
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
          fileKey: FILE_KEY_PARAM,
        },
        handler: async (
          { fileKey, ...target }: ScreenshotOptions & { fileKey?: string },
          call: FramelinkToolCall<CodeModeFacts>,
          extra: ToolExtra,
        ) => {
          if (!runtime) {
            call.record({ outcome: "refused", failure: "remote_caller" });
            return localWritesRefusal();
          }
          call.record({ outcome: "not_run" });
          // Known params are type-checked by the SDK; their value-level misuse is checked here, in
          // the same retryable shape as an unknown param, so the agent fixes the call and retries.
          const targetFileKey = fileKeyParam(fileKey);
          if (targetFileKey === "invalid") return fileKeyReply();
          const inputError = screenshotInputError(target);
          if (inputError) {
            call.reject({ field: "(root)", rule: "screenshot_target" });
            return retryableToolReply(
              `get_screenshot: ${inputError} This is NOT a failure: correct the arguments and retry.`,
            );
          }
          return answeringExpectedFailures(call, extra, {}, async () => {
            const located = await pluginCallTarget(runtime, call, {}, extra, {
              fileKey: targetFileKey,
              session: null,
            });
            if ("reply" in located) return located.reply;
            const { link } = located;
            const outcome = await capturePluginScreenshot(
              runtime.bridge,
              located,
              target,
              extra.signal,
            );
            if (outcome.kind === "not-granted")
              return notGrantedReply(call, {}, located, outcome.reason);
            const reply = outcome.reply;
            const failed = "errors" in reply;
            call.record({
              ...ownedBy(link),
              outcome: "captured",
              failure: failed ? "screenshot_failed" : undefined,
            });
            if (failed) return { content: [{ type: "text", text: reply.errors }], isError: true };
            return {
              content: [
                { type: "text", text: ranIn(located.document) },
                { type: "image", data: reply.image, mimeType: "image/png" },
              ],
            };
          });
        },
      },
      observe,
    ),

    registerFramelinkTool(
      server,
      {
        name: "pair_figma_plugin",
        unknownParams: "fail-loud",
        description:
          "Pair this server with the Framelink plugin in Figma, so figma_execute_code and " +
          "get_screenshot can reach it. Pairing is remembered: it is needed once, when a tool says " +
          "pairing is required. Call it without a code to show a pairing code in the plugin panel. " +
          "Pass code only after the user confirms the plugin panel shows exactly that code.",
        inputSchema: {
          code: z
            .string()
            .optional()
            .describe(
              "The pairing code the user confirmed the Framelink plugin panel shows, e.g. 7QKM-X2D9. Never guess or copy it from anywhere but the user's confirmation.",
            ),
        },
        handler: async (
          { code }: { code?: string },
          call: FramelinkToolCall<CodeModeFacts>,
          extra: ToolExtra,
        ) => {
          if (!runtime) {
            call.record({ outcome: "refused", failure: "remote_caller" });
            return localWritesRefusal();
          }
          call.record({ outcome: "not_run" });
          const { bridge } = runtime;
          if (code === undefined) {
            const pairing = await pairPluginLink(
              bridge,
              pairingCodeAsker(extra),
              extra.signal,
              "mcp",
            );
            if (pairing.kind === "blocked") return blockedCallReply(call, {}, pairing);
            call.record({
              ...(pairing.kind === "paired" ? ownedBy(pairing.link) : {}),
              outcome: "paired",
            });
            return retryableToolReply(PAIRED_TEXT);
          }
          const confirmed = await bridge.confirmPairing(code);
          if (confirmed.kind === "failed") {
            call.record({ outcome: "failed", failure: "pairing_failed" });
            return { isError: true, content: [{ type: "text", text: confirmed.reason }] };
          }
          if (confirmed.kind === "paired") {
            call.record({ ...ownedBy(confirmed.link), outcome: "paired" });
            return retryableToolReply(PAIRED_TEXT);
          }
          // An agent retrying a confirmation that already went through is told so, not sent round.
          const resolution = await bridge.resolveLink(extra.signal);
          if (resolution.kind === "linked") {
            call.record({ outcome: "paired" });
            return retryableToolReply(PAIRED_TEXT);
          }
          call.record({ outcome: "not_run", failure: "pairing_code_unknown" });
          return { isError: true, content: [{ type: "text", text: pairingCodeUnknownText(code) }] };
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
  // A caller without the plugin grant always sees the tools, so a call meets the loopback refusal
  // rather than "disabled", and the list reveals nothing of the operator's plugin.
  if (codeMode || !runtime) return;
  // disable() before the transport connects is a silent flag flip (the SDK skips the list_changed
  // notification when disconnected), so clients never see a flap.
  bindPluginAdvertisement(presence, transport, (expected) => {
    for (const tool of tools) {
      if (expected) tool.enable();
      else tool.disable();
    }
  });
}

/** Why a call got no plugin link, recorded and answered. */
function blockedCallReply(
  call: FramelinkToolCall<CodeModeFacts>,
  facts: CodeModeFacts,
  blocked: Extract<PluginCallTargeting, { kind: "blocked" }>,
): CallToolResult {
  call.record({ ...facts, outcome: "not_run", failure: blocked.block });
  const content = [{ type: "text" as const, text: blocked.text }];
  return blocked.isError ? { isError: true, content } : { content };
}

const FILE_KEY_PARAM = z
  .string()
  .optional()
  .describe(
    "The Figma file to work in: the key from its URL (figma.com/design/<fileKey>/…). Runs there only, and the user is asked in that file to allow this project if they haven't. Omit to use the one open file this project may edit; with several, or none yet, the user picks one in Figma.",
  );

/** The fileKey param, branded once here at the edge: null when omitted. */
function fileKeyParam(fileKey: string | undefined): FigmaFileKey | null | "invalid" {
  if (fileKey === undefined) return null;
  return parseFigmaFileKey(fileKey) ?? "invalid";
}

function fileKeyReply(): CallToolResult {
  return retryableToolReply(
    "fileKey must be the alphanumeric key from a Figma file URL (figma.com/design/<fileKey>/…), so this call did not run. This is NOT a failure: correct fileKey, or omit it, and retry.",
  );
}

/** The session param, branded once here at the edge: null when omitted. */
function sessionParam(session: string | undefined): SessionHandle | null | "invalid" {
  if (session === undefined) return null;
  return parseSessionHandle(session) ?? "invalid";
}

function sessionReply(): CallToolResult {
  return retryableToolReply(
    "session must be the four-word handle a figma_execute_code reply named (e.g. maple-orbit-velvet-quarry), so this call did not run. This is NOT a failure: copy the handle exactly, or omit session to start a fresh one, and retry.",
  );
}

/** Every run is in a session, and the agent keeps it only by passing this handle back. */
function usedSession(session: SessionHandle): string {
  return `Session: ${session} (pass it as session to continue with this session's values)`;
}

/** Every reply names the document it ran against, so a wrong file is noticed on the first call. */
function ranIn({ fileName, fileKey }: CallDocument): string {
  return `Figma file: "${fileName}" (fileKey ${fileKey})`;
}

// How long a client's pairing prompt may stay open before the call falls back to agent guidance.
const PAIRING_PROMPT_MAX_MS = 90_000;

const PAIRED_TEXT =
  "Paired: this server and the Framelink plugin are linked, and stay linked across restarts. Retry the call that needed the plugin.";

function localWritesRefusal(): CallToolResult {
  return { isError: true, content: [{ type: "text", text: LOCAL_WRITES_NEED_LOOPBACK }] };
}

/** Leaves an ordinary path bare so the suggested command reads cleanly; quotes anything a shell would split. */
function shellQuotedPath(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
}
