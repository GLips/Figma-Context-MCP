/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import {
  MAX_INTENT_LENGTH,
  MAX_SCREENSHOT_SCALE,
  type IntentProblem,
} from "@framelink/plugin/protocol";
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
import { callWaitLine, type CallWait } from "~/commercial/plugin-bridge/call-wait.js";
import {
  notGrantedText,
  pairingCodeUnknownText,
  quoteFigmaName,
  sessionNotFoundText,
} from "~/commercial/plugin-bridge/blocked-call-guidance.js";
import {
  ExecutionReplyLostError,
  executePluginCode,
  capturePluginScreenshot,
  type PluginCallTarget,
} from "~/commercial/plugin-bridge/execution.js";
import {
  BridgeRequestError,
  type CallDocument,
  type PluginLink,
  type RunWatch,
} from "~/commercial/plugin-bridge/bridge.js";
import { PLUGIN_ANSWER_MS } from "~/commercial/plugin-bridge/run-ledger.js";
import {
  DetachedRunRegistry,
  parseRunHandle,
  type DetachedRunKind,
  type DetachedRunStatus,
} from "./detached-runs.js";
import {
  CHECKED_IN_BEFORE_SENDING,
  MCP_CHECK_IN_MS,
  checkedInReply,
  launchPluginRun,
  neverSentReply,
  waitOnPluginRun,
  type PluginRun,
  type PluginRunEnd,
} from "./plugin-run-waiting.js";
import { parseDocumentId, type DocumentId } from "~/commercial/plugin-bridge/document-id.js";
import {
  intentProblemText,
  parseCallIntent,
  type CallIntent,
} from "~/commercial/plugin-bridge/call-intent.js";
import { parseFigmaFileKey, type FigmaFileKey } from "~/utils/figma-url.js";
import {
  parseSessionHandle,
  type SessionHandle,
} from "~/commercial/plugin-bridge/session-handle.js";
import type { CallerContext, ServerExtension, ServerExtensionContext } from "~/mcp/index.js";
import { getFigmaDataTool } from "~/mcp/tools/index.js";
import { registerFramelinkTool, type FramelinkToolCall } from "~/mcp/framelink-tool.js";
import { retryableToolReply } from "~/mcp/fail-loud-params.js";
import type { ToolEventProperties } from "~/telemetry/index.js";
import { referenceDocumentsNote } from "~/commercial/plugin-bridge/reference-documents-note.js";
import { createBridgeAnnotationSource } from "~/commercial/plugin-bridge/annotation-watch.js";
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
  // One per process, shared by every MCP server instance: a run detached by one stateless HTTP
  // request is awaited by another.
  const detachedRuns: DetachedRuns = new DetachedRunRegistry();
  return {
    describeReadRecovery: ({ plugin }) =>
      plugin && ((error, request) => describePluginReadRecovery(plugin, error, request)),
    annotationChanges: ({ plugin }) => plugin && createBridgeAnnotationSource(plugin.bridge),
    register(server, context) {
      // A remote caller can't use the plugin, so get_figma_data mustn't point it there.
      if (context.caller.plugin)
        advertisePluginReadRoute(context.getFigmaData, presence, {
          baseDescription: getFigmaDataTool.description,
          transport: context.transport,
        });
      registerCodeModeTools(server, presence, { ...context, codeMode, detachedRuns });
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
  /** The run outlived its call's check-in, so this is recorded when it ended, not when the call did. */
  checked_in?: boolean;
  /** await_figma_execution: where the run it named stood when the await answered. */
  run_status?: DetachedRunStatus | "gone" | "unknown";
};

/** The process's detached runs, each held as the tool that started it holds it. */
type DetachedRuns = DetachedRunRegistry<PluginRun<CodeModeFacts>>;

/** Who a run is attributed to: the Figma user its plugin link is signed in as. */
function ownedBy(link: PluginLink): CodeModeFacts {
  return link.owner ? { figma_user_id: link.owner.figmaUserId } : {};
}

/**
 * An expected way for a plugin call to end without a reply, as the result the SDK would have made of
 * the throw (the same text) and its telemetry code; null for anything else, which is a bug and
 * propagates. `not_run` only where the bridge proves nothing ran: a request lost after submission
 * may have run.
 */
function expectedRunFailure(
  error: unknown,
  signal: AbortSignal,
): { reply: CallToolResult; facts: CodeModeFacts } | null {
  const reply = (): CallToolResult => ({
    isError: true,
    content: [{ type: "text", text: (error as Error).message }],
  });
  if (error instanceof BridgeRequestError)
    return {
      reply: reply(),
      facts: {
        outcome: error.outcome === "not-submitted" ? "not_run" : "failed",
        failure: `bridge_${error.outcome.replace("-", "_")}`,
      },
    };
  if (signal.aborted) return { reply: reply(), facts: { outcome: "failed", failure: "cancelled" } };
  return null;
}

/** Targeting's expected failures, answered as results so only a bug escapes the handler. */
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
    call.record({ ...facts, ...failure.facts });
    return failure.reply;
  }
}

// A call queued behind a cancelled run waits on an end nothing here can hurry, from any link and for
// any cause: it is withdrawn at once.
const WITHDRAW_BEHIND_CANCELLED_RUN: RunWatch = {
  onWaiting: ({ wait, withdraw }) => {
    if (wait.blocker?.cancelledForMs !== undefined) void withdraw();
  },
};

type CodeModeToolsOptions = Pick<
  ServerExtensionContext<CodeModeCallerContext>,
  "caller" | "figmaService" | "transport" | "observe"
> & {
  /** Force the tools to be advertised from startup (`--code-mode`) instead of waiting for a plugin. */
  codeMode: boolean;
  detachedRuns: DetachedRuns;
};

/**
 * Register the code-mode (write-path) tools: figma_execute_code, get_flcm_reference, get_screenshot,
 * await_figma_execution, pair_figma_plugin.
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
  { codeMode, transport, caller, figmaService, observe, detachedRuns }: CodeModeToolsOptions,
): void {
  const runtime = caller.plugin;

  /**
   * The client's own prompt for confirming a pairing code, when it advertises form elicitation, open
   * until the call's `deadline` at most. Stateless HTTP never advertises it: it has no session to
   * carry the client's capabilities.
   */
  function pairingCodeAsker(extra: ToolExtra, deadline: number): PairingCodeAsker | null {
    if (!server.server.getClientCapabilities()?.elicitation?.form) return null;
    return async (code, expiresInMs, signal) => {
      // A client that advertises prompts but never answers must hand back while the code still has
      // time for the agent to ask instead.
      const timeout = Math.min(deadline - Date.now(), expiresInMs - PAIRING_GUIDANCE_MIN_LIFE_MS);
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
    {
      intent,
      document,
      fileKey,
      session,
    }: {
      intent: CallIntent;
      document: DocumentId | null;
      fileKey: FigmaFileKey | null;
      session: SessionHandle | null;
    },
    progress: CallProgress,
  ): Promise<PluginCallTarget | { reply: CallToolResult }> {
    // Every wait before the run, a person's answers included, ends in time for the check-in.
    const deadline = progress.checkInAt - PLUGIN_ANSWER_MS;
    const targeted = await targetForPluginCall(bridge, {
      intent,
      document,
      fileKey,
      session,
      pairing: { kind: "offer", ask: pairingCodeAsker(extra, deadline) },
      signal: extra.signal,
      surface: "mcp",
      deadline,
      onWaiting: (wait) => {
        progress.show(() => wait);
        return async () => progress.show(FINDING_FILE);
      },
    });
    if (targeted.kind === "targeted") return targeted;
    return { reply: blockedCallReply(call, facts, targeted) };
  }

  /**
   * A call's way to its plugin run: never started once the call is due to check in, and otherwise
   * run until it ends or the call checks in. Shared by figma_execute_code and get_screenshot.
   */
  async function runUntilCheckIn(
    runtime: PluginBridgeRuntime,
    tool: "figma_execute_code" | "get_screenshot",
    call: FramelinkToolCall<CodeModeFacts>,
    extra: ToolExtra,
    progress: CallProgress,
    target: PluginCallTarget,
    facts: CodeModeFacts,
    start: (signal: AbortSignal) => Promise<PluginRunEnd<CodeModeFacts>>,
  ): Promise<CallToolResult> {
    const kind: DetachedRunKind = tool === "get_screenshot" ? "screenshot" : "code";
    const startedAt = progress.checkInAt - MCP_CHECK_IN_MS;
    const owned = { ...facts, ...ownedBy(target.link) };
    const notSent = (): CallToolResult => {
      call.record({ ...owned, outcome: "not_run", failure: "checked_in_before_sending" });
      return neverSentReply(kind, target.document, Date.now() - startedAt);
    };
    if (Date.now() >= progress.checkInAt - PLUGIN_ANSWER_MS) return notSent();
    const run = launchPluginRun<CodeModeFacts>(
      {
        executionId: target.executionId,
        kind,
        bridge: runtime.bridge,
        document: target.document,
        startedAt,
      },
      extra.signal,
      async (signal) => {
        try {
          return await start(signal);
        } catch (error) {
          if (signal.reason === CHECKED_IN_BEFORE_SENDING)
            return {
              reply: neverSentReply(kind, target.document, Date.now() - startedAt),
              session: null,
              facts: { ...owned, outcome: "not_run", failure: "checked_in_before_sending" },
            };
          const failure = expectedRunFailure(error, signal);
          if (!failure) throw error;
          return {
            reply: failure.reply,
            // A fresh session exists nowhere else, so a lost reply keeps it for an expired result.
            session: error instanceof ExecutionReplyLostError ? error.session : null,
            facts: { ...owned, ...failure.facts },
          };
        }
      },
    );
    progress.show(() => ({ kind: "run", state: runtime.bridge.runState(run.executionId) }));
    const waited = await waitOnPluginRun(run, {
      checkInAt: progress.checkInAt,
      signal: extra.signal,
      first: true,
    });
    if (waited.kind === "never-sent") return notSent();
    if (waited.kind === "checked-in") {
      run.detachCaller();
      const handle = detachedRuns.detach(runtime, kind, run, run.ended);
      // The call answers now, but the run is what it reports: once, when the run ends.
      call.record({ ...owned, checked_in: true });
      call.completeLater(
        run.ended.then((end) => ({
          isError: !!end.reply.isError,
          facts: { ...end.facts, checked_in: true },
        })),
      );
      return checkedInReply(run, handle, {
        lead: ranIn(target.document),
        resultTtlMs: detachedRuns.resultTtlMs,
      });
    }
    // Abandoned: the caller's cancellation reached the run too, which ends at once.
    const end = waited.kind === "ended" ? waited.end : await run.ended;
    call.record(end.facts);
    return end.reply;
  }

  function scriptSourceReply(got: "neither" | "both"): CallToolResult {
    return retryableToolReply(
      `figma_execute_code needs exactly one of code or scriptPath, and got ${got}, so this call did ` +
        `not run. This is NOT a failure: retry with one of them.`,
    );
  }

  /** The plugin refused a bound call on arrival: its grant was revoked, or its file was re-stamped. */
  function notGrantedEnd(
    facts: CodeModeFacts,
    target: PluginCallTarget,
    reason: "no-grant" | "other-document",
  ): PluginRunEnd<CodeModeFacts> {
    return {
      reply: {
        isError: true,
        content: [{ type: "text", text: notGrantedText(reason, target.document.fileName) }],
      },
      session: null,
      facts: { ...facts, outcome: "refused", failure: `not_granted_${reason.replace("-", "_")}` },
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
          intent: INTENT_PARAM,
          document: DOCUMENT_PARAM,
          fileKey: FILE_KEY_PARAM,
          session: z
            .string()
            .optional()
            .describe(
              "The session handle a previous figma_execute_code reply named (four words, e.g. maple-orbit-velvet-quarry), to keep that call's `session` values and session.last. The call runs in the document that session is in. Omit to start a fresh session; every reply names the handle of the session it used.",
            ),
          scriptPath: z
            .string()
            .optional()
            .describe(
              "Path to a .js file holding the same kind of script, read when the call arrives. Must be inside the server's asset root (the --asset-root directory, default the server's working directory); a relative path resolves against that root, so prefer an absolute path. Use it for long scripts: after an error, edit the file and resend only the path. " +
                `For a file outside the root, send it as code, or from a shell run \`npx ${CLI_NAME} execute <file> --intent <why>\`.`,
            ),
        },
        handler: async (
          {
            code,
            scriptPath,
            intent,
            document,
            fileKey,
            session,
          }: {
            code?: string;
            scriptPath?: string;
            intent?: string;
            document?: string;
            fileKey?: string;
            session?: string;
          },
          call: FramelinkToolCall<CodeModeFacts>,
          extra: ToolExtra,
        ) => {
          const checkInAt = Date.now() + MCP_CHECK_IN_MS;
          const source = { script_source: code === undefined ? "script_path" : "code" };
          // Before scriptPath is read: the asset root is part of the grant.
          if (!runtime) {
            call.record({ ...source, outcome: "refused", failure: "remote_caller" });
            return localWritesRefusal();
          }
          call.record({ ...source, outcome: "not_run" });
          if (code !== undefined && scriptPath !== undefined) return scriptSourceReply("both");
          const callIntent = parseCallIntent(intent);
          if (callIntent.kind === "invalid")
            return intentReply(call, "figma_execute_code", callIntent);
          const targetDocument = documentParam(document);
          if (targetDocument === "invalid") return documentReply();
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
                    `\`npx ${CLI_NAME} execute ${shellQuoted(resolvePath(cause.assetRoot, scriptPath))} --intent ${shellQuoted(callIntent.intent)}\`, ` +
                    `which reads the file on your side with your own permissions (a human allows ` +
                    `this project in the Figma plugin)`
                  : "correct scriptPath, or send the script inline as code";
              call.record({ ...source, outcome: "not_run", failure: "script_unreadable" });
              return retryableToolReply(
                `figma_execute_code ${message}, so this call did not run. This is NOT a failure: ${remedy}.`,
              );
            }
          } else return scriptSourceReply("neither");
          const progress = startCallProgress(extra, checkInAt);
          try {
            return await answeringExpectedFailures(call, extra, source, async () => {
              const target = await pluginCallTarget(
                runtime,
                call,
                source,
                extra,
                {
                  intent: callIntent.intent,
                  document: targetDocument,
                  fileKey: targetFileKey,
                  session: targetSession,
                },
                progress,
              );
              if ("reply" in target) return target.reply;
              const owned = { ...source, ...ownedBy(target.link) };
              return runUntilCheckIn(
                runtime,
                "figma_execute_code",
                call,
                extra,
                progress,
                target,
                source,
                async (signal): Promise<PluginRunEnd<CodeModeFacts>> => {
                  const outcome = await executePluginCode(runtime, target, script, {
                    figma: figmaService,
                    signal,
                    ...WITHDRAW_BEHIND_CANCELLED_RUN,
                  });
                  if (outcome.kind === "not-granted")
                    return notGrantedEnd(owned, target, outcome.reason);
                  if (outcome.kind === "session-not-found")
                    return {
                      reply: {
                        isError: true,
                        content: [
                          { type: "text", text: sessionNotFoundText(outcome.session, "mcp") },
                        ],
                      },
                      session: null,
                      facts: { ...source, outcome: "not_run", failure: "session_not_found" },
                    };
                  if (outcome.kind === "refused")
                    return {
                      reply: { content: [{ type: "text", text: outcome.message }], isError: true },
                      session: null,
                      facts: { ...owned, outcome: "refused", failure: outcome.refusal.reason },
                    };
                  return {
                    reply: {
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
                    },
                    session: outcome.session,
                    facts: {
                      ...owned,
                      outcome: "executed",
                      script_errored: outcome.reply.errors !== null,
                    },
                  };
                },
              );
            });
          } finally {
            await progress.stop();
          }
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
          // Docs still serve on a stale or unpaired plugin — but lead with the open files and what
          // blocks a write, so the agent can name its file before its first refused write. The link is the operator's: a
          // caller without the plugin grant learns nothing of it.
          const note = runtime && (await referenceDocumentsNote(runtime.bridge, "reference"));
          return {
            content: [
              ...(note ? [{ type: "text" as const, text: note.text }] : []),
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
          intent: INTENT_PARAM,
          document: DOCUMENT_PARAM,
          fileKey: FILE_KEY_PARAM,
        },
        handler: async (
          {
            intent,
            document,
            fileKey,
            ...target
          }: ScreenshotOptions & { intent?: string; document?: string; fileKey?: string },
          call: FramelinkToolCall<CodeModeFacts>,
          extra: ToolExtra,
        ) => {
          const checkInAt = Date.now() + MCP_CHECK_IN_MS;
          if (!runtime) {
            call.record({ outcome: "refused", failure: "remote_caller" });
            return localWritesRefusal();
          }
          call.record({ outcome: "not_run" });
          // Known params are type-checked by the SDK; their value-level misuse is checked here, in
          // the same retryable shape as an unknown param, so the agent fixes the call and retries.
          const callIntent = parseCallIntent(intent);
          if (callIntent.kind === "invalid") return intentReply(call, "get_screenshot", callIntent);
          const targetDocument = documentParam(document);
          if (targetDocument === "invalid") return documentReply();
          const targetFileKey = fileKeyParam(fileKey);
          if (targetFileKey === "invalid") return fileKeyReply();
          const inputError = screenshotInputError(target);
          if (inputError) {
            call.reject({ field: "(root)", rule: "screenshot_target" });
            return retryableToolReply(
              `get_screenshot: ${inputError} This is NOT a failure: correct the arguments and retry.`,
            );
          }
          const progress = startCallProgress(extra, checkInAt);
          try {
            return await answeringExpectedFailures(call, extra, {}, async () => {
              const located = await pluginCallTarget(
                runtime,
                call,
                {},
                extra,
                {
                  intent: callIntent.intent,
                  document: targetDocument,
                  fileKey: targetFileKey,
                  session: null,
                },
                progress,
              );
              if ("reply" in located) return located.reply;
              const owned = ownedBy(located.link);
              return runUntilCheckIn(
                runtime,
                "get_screenshot",
                call,
                extra,
                progress,
                located,
                {},
                async (signal): Promise<PluginRunEnd<CodeModeFacts>> => {
                  const outcome = await capturePluginScreenshot(runtime.bridge, located, target, {
                    signal,
                    ...WITHDRAW_BEHIND_CANCELLED_RUN,
                  });
                  if (outcome.kind === "not-granted")
                    return notGrantedEnd(owned, located, outcome.reason);
                  const reply = outcome.reply;
                  const facts: CodeModeFacts = { ...owned, outcome: "captured" };
                  if ("errors" in reply)
                    return {
                      reply: { content: [{ type: "text", text: reply.errors }], isError: true },
                      session: null,
                      facts: { ...facts, failure: "screenshot_failed" },
                    };
                  return {
                    reply: {
                      content: [
                        { type: "text", text: ranIn(located.document) },
                        { type: "image", data: reply.image, mimeType: "image/png" },
                      ],
                    },
                    session: null,
                    facts,
                  };
                },
              );
            });
          } finally {
            await progress.stop();
          }
        },
      },
      observe,
    ),

    registerFramelinkTool(
      server,
      {
        name: "await_figma_execution",
        unknownParams: "fail-loud",
        description: AWAIT_EXECUTION_DESCRIPTION,
        inputSchema: {
          // Optional at the wire, like intent, so a missing one reaches the handler's guidance.
          run: z
            .string()
            .optional()
            .describe(
              "Required. The run handle a figma_execute_code or get_screenshot reply named (e.g. run-7k2m9q4r8t1v3x5z9abc), exactly as given.",
            ),
          cancel: z
            .boolean()
            .optional()
            .describe(
              "Stop the run instead of waiting for it. Cancellation is cooperative: a run still queued never starts, a running one stops before its next Figma call, and its writes so far stay.",
            ),
        },
        handler: async (
          { run, cancel }: { run?: string; cancel?: boolean },
          call: FramelinkToolCall<CodeModeFacts>,
          extra: ToolExtra,
        ) => {
          const checkInAt = Date.now() + MCP_CHECK_IN_MS;
          if (!runtime) {
            call.record({ outcome: "refused", failure: "remote_caller" });
            return localWritesRefusal();
          }
          const handle = parseRunHandle(run ?? "");
          if (!handle) {
            call.reject({
              field: "run",
              rule: run === undefined ? "run_missing" : "run_malformed",
            });
            return retryableToolReply(
              "await_figma_execution needs run: the run handle a figma_execute_code or get_screenshot reply named (run- and 20 letters and digits), exactly as given. This is NOT a failure: copy the handle and retry.",
            );
          }
          const found = detachedRuns.lookup(runtime, handle);
          if (found.state === "unknown") {
            call.record({ run_status: "unknown" });
            return { isError: true, content: [{ type: "text", text: unknownRunText(handle) }] };
          }
          if (found.state === "gone") {
            call.record({ run_status: "gone" });
            return { isError: true, content: [{ type: "text", text: goneRunText(handle, found) }] };
          }
          if (found.state === "finished") {
            call.record({ run_status: found.status });
            if (!cancel) return found.outcome.reply;
            const { reply } = found.outcome;
            return {
              ...reply,
              content: [
                { type: "text", text: `Nothing to cancel: run ${handle} had already finished.` },
                ...reply.content,
              ],
            };
          }
          const { working } = found;
          if (cancel) {
            detachedRuns.markCancelRequested(working);
            working.run.bridge.cancelRun(working.run.executionId);
          }
          const progress = startCallProgress(extra, checkInAt);
          progress.show(() => ({
            kind: "run",
            state: working.run.bridge.runState(working.run.executionId),
          }));
          try {
            const waited = await waitOnPluginRun(working.run, {
              checkInAt,
              signal: extra.signal,
              first: false,
            });
            if (waited.kind === "ended") {
              const { reply } = waited.end;
              call.record({
                run_status: !reply.isError ? "completed" : cancel ? "cancelled" : "failed",
              });
              return reply;
            }
            call.record({ run_status: "working" });
            return checkedInReply(working.run, handle, {
              lead: ranIn(working.run.document),
              resultTtlMs: detachedRuns.resultTtlMs,
            });
          } finally {
            await progress.stop();
          }
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
              pairingCodeAsker(extra, Date.now() + MCP_CHECK_IN_MS),
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

const AWAIT_EXECUTION_DESCRIPTION =
  "Wait for, or cancel, a figma_execute_code or get_screenshot run that outlived its call. Those " +
  `calls answer within about ${MCP_CHECK_IN_MS / 1000} seconds; a run still going then keeps going, ` +
  "and the reply names a run handle, how long Figma has been quiet and its oldest pending call " +
  "instead of the result. Pass the handle here to get exactly the reply the original call would have " +
  "returned: the code's result and console, or the screenshot image. A run still going after another " +
  `${MCP_CHECK_IN_MS / 1000} seconds gets its status again: await again, or pass cancel: true. A result ` +
  "can be fetched again until it expires, 10 minutes after the run finished.";

/** One call's progress line for clients that show progress, and when the call checks in. */
interface CallProgress {
  checkInAt: number;
  /** What the call waits on now: read at each heartbeat, so a run's state and a wait's age stay current. */
  show(wait: () => CallWait): void;
  stop(): Promise<void>;
}

const FINDING_FILE = (): CallWait => ({ kind: "finding-file" });

function startCallProgress(extra: ToolExtra, checkInAt: number): CallProgress {
  let wait = FINDING_FILE;
  const stop = startProgressHeartbeat(extra, () => callWaitLine(wait(), Date.now()), 3000);
  return {
    checkInAt,
    show: (next) => {
      wait = next;
    },
    stop,
  };
}

/** An await of a handle this process never minted, or minted for someone else. */
function unknownRunText(handle: string): string {
  return (
    `Outcome unavailable: this server knows no run ${handle}. It keeps runs in memory only, so a ` +
    `server restart since the run started loses them, and that does not mean the run didn't ` +
    `happen. Check the document before redoing its work.`
  );
}

/** An await of a run whose result was dropped: what is left to read instead. */
function goneRunText(
  handle: string,
  {
    reason,
    kind,
    session,
  }: { reason: "expired" | "evicted"; kind: DetachedRunKind; session: SessionHandle | null },
): string {
  const lead =
    reason === "expired"
      ? `Result expired: run ${handle} finished, and its result is kept only 10 minutes after that.`
      : `Result evicted: run ${handle} finished, and its result was dropped to make room for newer ones.`;
  if (kind === "screenshot") return `${lead} Take the screenshot again.`;
  return session
    ? `${lead} Session ${session} may still contain the latest returned value in session.last: pass ` +
        `it as session to figma_execute_code and return session.last.`
    : `${lead} Check the document before redoing its work.`;
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

// Optional at the wire, like code, so a missing one reaches intentReply's guidance rather than the
// SDK's fixed validation error.
const INTENT_PARAM = z
  .string()
  .optional()
  .describe(
    `Required. One line of plain text, at most ${MAX_INTENT_LENGTH} characters, saying what this call is for, e.g. "Rebuild the pricing card with the new tokens". The user sees it in the Framelink plugin panel, in its activity list and on any Allow prompt this call raises. It never chooses the file.`,
  );

/** A missing or malformed intent: nothing was sent, and the agent adds one and retries. */
function intentReply(
  call: FramelinkToolCall<CodeModeFacts>,
  tool: string,
  { problem }: { problem: IntentProblem },
): CallToolResult {
  call.reject({ field: "intent", rule: `intent_${problem.replace(/-/g, "_")}` });
  return retryableToolReply(
    `${tool}: ${intentProblemText(problem, "intent")} This call did not run. This is NOT a failure: fix intent and retry.`,
  );
}

const DOCUMENT_PARAM = z
  .string()
  .optional()
  .describe(
    "The Figma file to work in: its document id, as a refusal or get_flcm_reference lists the open files (16 characters, e.g. 7k2m9q4r8t1v3x5z). Runs there only, and if this project isn't allowed there yet the user is asked to Allow it in that file. Omit to use the one open file this project may edit; otherwise the call is refused with the open files to choose from by name.",
  );

const FILE_KEY_PARAM = z
  .string()
  .optional()
  .describe(
    "Another way to name the file: the key from its URL (figma.com/design/<fileKey>/…). Matches only plugins that report a file key, so prefer document; a file the plugin reports no key for is never found by fileKey.",
  );

/** The document param, branded once here at the edge: null when omitted. */
function documentParam(document: string | undefined): DocumentId | null | "invalid" {
  if (document === undefined) return null;
  return parseDocumentId(document) ?? "invalid";
}

function documentReply(): CallToolResult {
  return retryableToolReply(
    "document must be a document id exactly as a refusal or get_flcm_reference listed it (16 characters), so this call did not run. This is NOT a failure: copy the id, or omit document, and retry.",
  );
}

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
function ranIn({ fileName, documentId, fileKey }: CallDocument): string {
  return `Figma file: ${quoteFigmaName(fileName)} (document ${documentId}${fileKey ? `, fileKey ${fileKey}` : ""})`;
}

const PAIRED_TEXT =
  "Paired: this server and the Framelink plugin are linked, and stay linked across restarts. Retry the call that needed the plugin.";

function localWritesRefusal(): CallToolResult {
  return { isError: true, content: [{ type: "text", text: LOCAL_WRITES_NEED_LOOPBACK }] };
}

/** Leaves an ordinary word bare so the suggested command reads cleanly; quotes anything a shell would split. */
function shellQuoted(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}
