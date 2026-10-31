/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { command } from "cleye";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolvePluginConfig, UsageError } from "~/config.js";
import { FIGMA_REST_CREDENTIAL_FLAGS } from "~/commands/rest-command.js";
import { defineCliCommand } from "~/commands/cli-command.js";
import { printCliFailure, type CliCommandContext } from "~/commands/cli-context.js";
import { FigmaService, staticCredentialSource } from "~/services/figma.js";
import { captureObservedCall, type ToolEventProperties } from "~/telemetry/index.js";
import type { OperationCall } from "~/utils/observed-operation.js";
import { startPluginBridge } from "~/commercial/plugin-bridge/index.js";
import {
  executePluginCode,
  capturePluginScreenshot,
  type PluginCallTarget,
} from "~/commercial/plugin-bridge/execution.js";
import type { PluginLink } from "~/commercial/plugin-bridge/bridge.js";
import { BridgeRequestError } from "~/commercial/plugin-bridge/run-ledger.js";
import { isSavedScriptPath } from "~/commercial/plugin-bridge/saved-script.js";
import { MAX_INTENT_LENGTH, MAX_SCREENSHOT_SCALE, queueWaitKey } from "@framelink/plugin/protocol";
import type { RunWatch } from "~/commercial/plugin-bridge/run-ledger.js";
import { queueWaitText } from "~/commercial/plugin-bridge/run-outcome-text.js";
import { screenshotInputError } from "~/commercial/plugin-bridge/screenshot-options.js";
import { callWaitLine } from "~/commercial/plugin-bridge/call-wait.js";
import {
  notGrantedText,
  quoteFigmaName,
  sessionNotFoundText,
} from "~/commercial/plugin-bridge/blocked-call-guidance.js";
import { parseSessionHandle } from "~/commercial/plugin-bridge/session-handle.js";
import { parseDocumentId } from "~/commercial/plugin-bridge/document-id.js";
import { intentProblemText, parseCallIntent } from "~/commercial/plugin-bridge/call-intent.js";
import { mintExecutionId } from "~/commercial/execution-id.js";
import { targetForPluginCall } from "~/commercial/plugin-bridge/plugin-call-link.js";
import { parseFigmaFileKey } from "~/utils/figma-url.js";
import { buildQuickStart } from "~/commercial/tools/flcm-docs/reference.js";
import { withoutTokenMarks } from "~/commercial/tools/token-tree.js";
import { CLI_DOCS_CHANNEL } from "~/commercial/tools/flcm-docs/channels.js";
import { buildCommandHelp } from "~/utils/cli-help.js";
import {
  DEFAULT_PLUGIN_WAIT_SECONDS,
  pluginWaitDeadline,
  waitForPluginConnection,
} from "./plugin-wait.js";

export const executeCommand = defineCliCommand(
  command({
    name: "execute",
    strictFlags: true,
    parameters: ["<script>"],
    help: buildCommandHelp({
      name: "execute",
      summary: "Run an flcm script in the Figma file the Framelink plugin has open",
      details: `The script is the body of an async function: use await and return directly, with no imports or
exports. --intent says in one line what the run is for; the plugin panel shows it to the person in
Figma, with the run's outcome and on any Allow prompt the run raises. Open the Framelink plugin in
the target file first. The plugin must be paired once (run
\`pair\`). --document runs only in that file, and the first run from a project there waits for you
to click Allow in the plugin. Without it, the run goes to the one open file this project may edit;
otherwise it is refused with the open files and their document ids (\`reference --files\` lists
them too). No Figma API token is needed; one lets the script read the file's comment pins, where
the plugin reports the file's key.

Each run gets a fresh \`session\` unless --session names the one an earlier run's reply did: that
run continues it, with its session values and session.last, in the file the session is in. A
session lasts as long as the plugin stays open.

stdout gets the reply as JSON, { file, session, result, console, errors }; progress goes to
stderr. Exits 0 when errors is null, 1 on a script, connection or grant failure, 130 on Ctrl-C. A
run is never resubmitted automatically.`,
      exampleArgs: [
        `card.js --intent "Build the pricing card"`,
        `card.js --intent "Build the pricing card" --document 7k2m9q4r8t1v3x5z`,
        `tweak.js --intent "Tighten the card's padding" --session maple-orbit-velvet-quarry`,
        `card.js --intent "Build the pricing card" --output out/reply.json --screenshot out/card.png --key card --scale 2`,
        `card.js --intent "Check the card among its neighbours" --screenshot out/card.png --key card --context --margin 120`,
      ],
      // After the flags because it is what the script file needs; its FULL DOCS line is the next
      // disclosure step, into `reference`.
      appendix: [{ title: "Writing the script:", body: buildQuickStart(CLI_DOCS_CHANNEL) }],
    }),
    flags: {
      intent: {
        type: String,
        placeholder: "<text>",
        description: `Required: what this run is for, one line of at most ${MAX_INTENT_LENGTH} characters, shown in the plugin panel`,
      },
      document: {
        type: String,
        placeholder: "<id>",
        description:
          "Run only in this Figma file: its document id, as a refusal or `reference --files` lists it",
      },
      fileKey: {
        type: String,
        placeholder: "<key>",
        description:
          "Run only in the file with this key from its URL; matches only plugins that report a key",
      },
      session: {
        type: String,
        placeholder: "<handle>",
        description:
          "Continue the session an earlier run's reply named, with its session values and session.last",
      },
      output: {
        type: String,
        placeholder: "<reply.json>",
        description: "Also write the reply JSON to this file",
      },
      screenshot: {
        type: String,
        placeholder: "<file.png>",
        description:
          "After the run, save a PNG of the page (or of --node-id/--key), even if the script failed",
      },
      nodeId: {
        type: String,
        placeholder: "<id>",
        description: "Screenshot this node instead of the page",
      },
      key: {
        type: String,
        placeholder: "<key>",
        description: "Screenshot the node with this authored key instead of the page",
      },
      scale: {
        type: Number,
        placeholder: "<n>",
        description: `Screenshot resolution multiplier, above 0 and up to ${MAX_SCREENSHOT_SCALE} (default 1)`,
      },
      context: {
        type: Boolean,
        description: "Also capture the canvas around the --node-id/--key target",
      },
      margin: {
        type: Number,
        placeholder: "<px>",
        description:
          "Pixels of surrounding canvas on each side with --context (default 10% of the target's longest side, 80-160)",
      },
      wait: {
        type: Number,
        placeholder: "<seconds>",
        description: `Wait at most this long in all for the plugin to connect, find the file, and for you to allow this project in it; the run itself has no limit (default ${DEFAULT_PLUGIN_WAIT_SECONDS}; 0 fails at once)`,
      },
      assetRoot: {
        type: String,
        placeholder: "<dir>",
        description:
          "Local files flcm.image() may read must be inside this directory (default cwd; env FRAMELINK_ASSET_ROOT)",
      },
      ...FIGMA_REST_CREDENTIAL_FLAGS,
    },
  }),
  (argv, context) => runExecute(argv.flags, argv._, context),
);

interface ExecuteFlags {
  intent?: string;
  document?: string;
  fileKey?: string;
  session?: string;
  output?: string;
  screenshot?: string;
  nodeId?: string;
  key?: string;
  scale?: number;
  context?: boolean;
  margin?: number;
  wait?: number;
  assetRoot?: string;
}

/**
 * What a run reports, as figma_execute_code and get_screenshot report theirs (code-mode-tools.ts):
 * codes and flags only, never the script, its reply or a message.
 */
type CodeModeFacts = ToolEventProperties & {
  figma_user_id?: string;
  outcome?: "executed" | "captured" | "refused" | "failed" | "not_run";
  failure?: string;
};

/**
 * CLI file/stdio boundary. Execution and image policy live in the shared plugin services. The run
 * and its screenshot are recorded as the two calls an agent would make for them.
 */
export async function runExecute(
  flags: ExecuteFlags,
  positionals: string[],
  { signal, credential, observe }: CliCommandContext,
): Promise<number> {
  if (positionals.length !== 1 || !isSavedScriptPath(positionals[0])) {
    throw new UsageError("execute requires one .js file containing an async function body.");
  }
  const deadline = pluginWaitDeadline(flags.wait);
  const target = {
    nodeId: flags.nodeId,
    key: flags.key,
    scale: flags.scale,
    context: flags.context,
    margin: flags.margin,
  };
  const inputError = screenshotInputError(target);
  if (inputError) throw new UsageError(inputError);
  const intent = parseCallIntent(flags.intent);
  if (intent.kind === "invalid")
    throw new UsageError(intentProblemText(intent.problem, "--intent"));
  const document = flags.document === undefined ? null : parseDocumentId(flags.document);
  if (flags.document !== undefined && document === null)
    throw new UsageError("--document must be a document id exactly as Framelink listed it.");
  const fileKey = flags.fileKey === undefined ? null : parseFigmaFileKey(flags.fileKey);
  if (flags.fileKey !== undefined && fileKey === null)
    throw new UsageError("--file-key must be the alphanumeric key from a Figma file URL.");
  const session = flags.session === undefined ? null : parseSessionHandle(flags.session);
  if (flags.session !== undefined && session === null)
    throw new UsageError(
      "--session must be the four-word handle an earlier run's reply named, e.g. maple-orbit-velvet-quarry.",
    );
  if (!flags.screenshot && Object.values(target).some((value) => value !== undefined)) {
    throw new UsageError(
      "--node-id, --key, --scale, --context, and --margin require --screenshot <file.png>.",
    );
  }
  const file = resolve(positionals[0]);
  const destinations = [flags.output, flags.screenshot]
    .filter((path) => path !== undefined)
    .map((path) => resolve(path));
  if (new Set([file, ...destinations]).size !== destinations.length + 1) {
    throw new UsageError("Script, JSON output, and screenshot paths must be distinct.");
  }
  const code = await readFile(file, "utf8");
  for (const path of destinations) await mkdir(dirname(path), { recursive: true });
  // Optional, unlike the REST commands: it pays only for a run's mid-run Figma reads (comment pins).
  const figma = credential ? new FigmaService(staticCredentialSource(credential)) : null;

  const config = resolvePluginConfig(flags.assetRoot);
  const runtime = startPluginBridge({
    assetRoot: config.assetRoot.value,
    framelinkApiUrl: config.framelinkApiUrl.value,
  });
  // Set once the script has a reply, partial work included: only then is there a page to capture.
  const ran: { target: PluginCallTarget | null } = { target: null };
  try {
    const scriptExit = await observe(
      "figma_execute_code",
      captureObservedCall,
      async (call: OperationCall<CodeModeFacts>) => {
        // The CLI reads the script file on the caller's side, so it is always a saved script.
        const source = { script_source: "script_path" };
        call.record({ ...source, outcome: "not_run" });
        return answeringExpectedFailures(call, signal, source, async () => {
          const unconnected = await waitForPluginConnection(
            runtime.bridge,
            deadline,
            signal,
            "the script was not submitted",
          );
          if (unconnected !== null) {
            call.record({ ...source, outcome: "not_run", failure: "disconnected" });
            return printCliFailure(unconnected);
          }
          const bound = await targetForPluginCall(runtime.bridge, {
            intent: intent.intent,
            document,
            fileKey,
            session,
            // Pairing is the `pair` command's: it reads the person's typed code, which a run whose
            // stdin may be a pipe or an agent's shell can't count on.
            pairing: { kind: "refuse" },
            signal,
            surface: "cli",
            deadline,
            onWaiting: (wait) => {
              console.error(callWaitLine(wait, Date.now()));
              return async () => {};
            },
          });
          if (bound.kind === "blocked") {
            call.record({ ...source, outcome: "not_run", failure: bound.block });
            return printCliFailure(bound.text);
          }
          const { document: target } = bound;
          console.error(
            `Running in ${quoteFigmaName(target.fileName)} (document ${target.documentId}).`,
          );
          const outcome = await executePluginCode(runtime, bound, code, {
            figma,
            signal,
            onWaiting: printingQueueMoves(),
            onQuiet: printingQuietSpells(),
          });
          if (outcome.kind === "refused") {
            call.record({
              ...source,
              ...ownedBy(bound.link),
              outcome: "refused",
              failure: outcome.refusal.reason,
            });
            return printCliFailure(outcome.message);
          }
          if (outcome.kind === "not-granted") {
            call.record({
              ...source,
              ...ownedBy(bound.link),
              outcome: "refused",
              failure: `not_granted_${outcome.reason.replace("-", "_")}`,
            });
            return printCliFailure(notGrantedText(outcome.reason, target.fileName));
          }
          if (outcome.kind === "session-not-found") {
            call.record({ ...source, outcome: "not_run", failure: "session_not_found" });
            return printCliFailure(sessionNotFoundText(outcome.session, "cli"));
          }
          call.record({
            ...source,
            ...ownedBy(bound.link),
            outcome: "executed",
            script_errored: outcome.reply.errors !== null,
          });
          const reply = {
            file: target,
            session: outcome.session,
            ...withoutTokenMarks(outcome.reply),
          };
          const json = JSON.stringify(reply, null, 2) + "\n";
          process.stdout.write(json);
          if (flags.output) await writeFile(flags.output, json);
          if (reply.errors !== null) console.error(reply.errors);
          ran.target = bound;
          return reply.errors === null ? 0 : 1;
        });
      },
    );
    const screenshotPath = flags.screenshot;
    const scripted = ran.target;
    if (!screenshotPath || !scripted) return scriptExit;
    const screenshotExit = await observe(
      "get_screenshot",
      captureObservedCall,
      async (call: OperationCall<CodeModeFacts>) => {
        call.record({ outcome: "not_run" });
        return answeringExpectedFailures(call, signal, {}, async () => {
          // Its own execution: the script's id is spent on the run it named. It shows the run's intent.
          const captured = await capturePluginScreenshot(
            runtime.bridge,
            { ...scripted, executionId: mintExecutionId() },
            target,
            { signal, onWaiting: printingQueueMoves(), onQuiet: printingQuietSpells() },
          );
          if (captured.kind === "not-granted") {
            call.record({
              ...ownedBy(scripted.link),
              outcome: "refused",
              failure: `not_granted_${captured.reason.replace("-", "_")}`,
            });
            return printCliFailure(
              "The script ran (its reply is above), but the plugin refused the screenshot (the grant " +
                "was revoked or the file got a new identity), so no PNG was saved. Re-running would " +
                "repeat the script's writes; report this to the user or coordinating agent instead.",
            );
          }
          const screenshot = captured.reply;
          const failed = "errors" in screenshot;
          call.record({
            ...ownedBy(scripted.link),
            outcome: "captured",
            failure: failed ? "screenshot_failed" : undefined,
          });
          if ("errors" in screenshot)
            return printCliFailure(`Screenshot failed: ${screenshot.errors}`);
          await writeFile(screenshotPath, Buffer.from(screenshot.image, "base64"));
          return 0;
        });
      },
    );
    return scriptExit || screenshotExit;
  } finally {
    // After any cancelled run has had its answer: closing first would drop the plugin's reply.
    runtime.stop();
  }
}

/** Who a run is attributed to: the Figma user its plugin link is signed in as. */
function ownedBy(link: PluginLink): CodeModeFacts {
  return link.owner ? { figma_user_id: link.owner.figmaUserId } : {};
}

/**
 * The expected ways a plugin call ends without a reply are recorded as codes, as the MCP tools do,
 * and answered with exit 1; anything else is a bug and propagates. `failed`, not `not_run`: a
 * request lost after submission may have run.
 */
async function answeringExpectedFailures(
  call: OperationCall<CodeModeFacts>,
  signal: AbortSignal,
  facts: CodeModeFacts,
  run: () => Promise<number>,
): Promise<number> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BridgeRequestError) {
      call.record({
        ...facts,
        outcome: "failed",
        failure: `bridge_${error.outcome.replace("-", "_")}`,
      });
      return printCliFailure(error);
    }
    if (signal.aborted) {
      call.record({ ...facts, outcome: "failed", failure: "cancelled" });
      return 1;
    }
    throw error;
  }
}

// A quiet spell is announced once it is long enough to notice, then again at this cadence.
const QUIET_FIRST_ANNOUNCE_MS = 10_000;
const QUIET_REANNOUNCE_MS = 30_000;

/**
 * The CLI waits on a run however long Figma takes, so a person watching a quiet one is told why
 * nothing is happening and how to stop it.
 */
function printingQuietSpells(): RunWatch["onQuiet"] {
  let announceAt = QUIET_FIRST_ANNOUNCE_MS;
  let previous = 0;
  return (quietForMs) => {
    // Shorter than the last one: the run spoke in between, so this is a new spell.
    if (quietForMs < previous) announceAt = QUIET_FIRST_ANNOUNCE_MS;
    previous = quietForMs;
    if (quietForMs < announceAt) return;
    announceAt = quietForMs + QUIET_REANNOUNCE_MS;
    console.error(
      `No word from Figma for ${Math.round(quietForMs / 1000)}s; it may be busy (a large export or render). Waiting. Ctrl-C cancels.`,
    );
  };
}

/**
 * The CLI waits on a queued run with no budget, so the person watching is told where it stands: a
 * line when its place, its blocker, or the blocker's cancellation changes, never per heartbeat.
 */
function printingQueueMoves(): RunWatch["onWaiting"] {
  let shown: string | null = null;
  return ({ wait }) => {
    if (queueWaitKey(wait) === shown) return;
    shown = queueWaitKey(wait);
    console.error(queueWaitText(wait));
  };
}
