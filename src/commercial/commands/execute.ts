/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { type Command, command } from "cleye";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  loadEnvFile,
  resolveCredential,
  resolvePluginConfig,
  resolveProxy,
  UsageError,
} from "~/config.js";
import { FIGMA_REST_CREDENTIAL_FLAGS } from "~/commands/rest-command.js";
import { FigmaService, staticCredentialSource } from "~/services/figma.js";
import { installFigmaProxyDispatcher } from "~/utils/figma-proxy-dispatcher.js";
import { startPluginBridge } from "~/commercial/plugin-bridge/index.js";
import {
  executePluginCode,
  capturePluginScreenshot,
} from "~/commercial/plugin-bridge/execution.js";
import { isSavedScriptPath } from "~/commercial/plugin-bridge/saved-script.js";
import { MAX_SCREENSHOT_SCALE } from "@framelink/plugin/protocol";
import { screenshotInputError } from "~/commercial/plugin-bridge/screenshot-options.js";
import {
  GRANT_WAITING_TEXT,
  notGrantedText,
  sessionNotFoundText,
} from "~/commercial/plugin-bridge/blocked-call-guidance.js";
import { parseSessionHandle } from "~/commercial/plugin-bridge/session-handle.js";
import { parseDocumentId } from "~/commercial/plugin-bridge/document-id.js";
import { mintExecutionId } from "~/commercial/execution-id.js";
import { targetForPluginCall } from "~/commercial/plugin-bridge/plugin-call-link.js";
import { parseFigmaFileKey } from "~/utils/figma-url.js";
import { buildQuickStart } from "~/commercial/tools/flcm-docs/reference.js";
import { withoutTokenMarks } from "~/commercial/tools/token-tree.js";
import { CLI_DOCS_CHANNEL } from "~/commercial/tools/flcm-docs/channels.js";
import { buildCommandHelp } from "~/utils/cli-help.js";
import {
  DEFAULT_PLUGIN_WAIT_SECONDS,
  pluginWaitMs,
  waitForPluginConnection,
} from "./plugin-wait.js";

export const executeCommand: Command = command(
  {
    name: "execute",
    strictFlags: true,
    parameters: ["<script>"],
    help: buildCommandHelp({
      name: "execute",
      summary: "Run an flcm script in the Figma file the Framelink plugin has open",
      details: `The script is the body of an async function: use await and return directly, with no imports or
exports. Open the Framelink plugin in the target file first. The plugin must be paired once (run
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
        "card.js",
        "card.js --document 7k2m9q4r8t1v3x5z",
        "tweak.js --session maple-orbit-velvet-quarry",
        "card.js --output out/reply.json --screenshot out/card.png --key card --scale 2",
        "card.js --screenshot out/card.png --key card --context --margin 120",
      ],
      // After the flags because it is what the script file needs; its FULL DOCS line is the next
      // disclosure step, into `reference`.
      appendix: [{ title: "Writing the script:", body: buildQuickStart(CLI_DOCS_CHANNEL) }],
    }),
    flags: {
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
        description: `Wait this long for the plugin to connect, and again for you to allow this project in it (default ${DEFAULT_PLUGIN_WAIT_SECONDS}; 0 fails at once)`,
      },
      assetRoot: {
        type: String,
        placeholder: "<dir>",
        description:
          "Local files flcm.image() may read must be inside this directory (default cwd; env FRAMELINK_ASSET_ROOT)",
      },
      env: {
        type: String,
        placeholder: "<file>",
        description: "Load environment variables from this file (default ./.env)",
      },
      ...FIGMA_REST_CREDENTIAL_FLAGS,
    },
  },
  (argv) => {
    runExecute(argv.flags, argv._).then(
      (code) => {
        process.exitCode = code;
      },
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      },
    );
  },
);

interface ExecuteFlags {
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
  env?: string;
  figmaApiKey?: string;
  figmaOauthToken?: string;
  proxy?: string;
}

/** CLI file/stdio boundary. Execution and image policy live in the shared plugin services. */
export async function runExecute(flags: ExecuteFlags, positionals: string[]): Promise<number> {
  if (positionals.length !== 1 || !isSavedScriptPath(positionals[0])) {
    throw new UsageError("execute requires one .js file containing an async function body.");
  }
  const waitMs = pluginWaitMs(flags.wait);
  const target = {
    nodeId: flags.nodeId,
    key: flags.key,
    scale: flags.scale,
    context: flags.context,
    margin: flags.margin,
  };
  const inputError = screenshotInputError(target);
  if (inputError) throw new UsageError(inputError);
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
  loadEnvFile(flags.env);
  // Optional, unlike the REST commands: it pays only for a run's mid-run Figma reads (comment pins).
  const credential = resolveCredential(flags);
  if (credential) installFigmaProxyDispatcher(resolveProxy(flags).value);
  const figma = credential ? new FigmaService(staticCredentialSource(credential)) : null;

  const config = resolvePluginConfig(flags.assetRoot);
  const runtime = startPluginBridge({
    assetRoot: config.assetRoot.value,
    framelinkApiUrl: config.framelinkApiUrl.value,
  });
  const controller = new AbortController();
  let awaitingSettlement = false;
  let signalExit: number | undefined;
  // Closing the socket triggers the plugin's existing disconnect cancellation. Signal exits
  // retain conventional shell status; normal and error exits close in finally below.
  const interrupt = () => {
    signalExit = 130;
    controller.abort(new Error("Interrupted"));
  };
  const terminate = () => {
    signalExit = 143;
    controller.abort(new Error("Terminated"));
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    console.error(`Waiting up to ${waitMs / 1000}s for the Framelink plugin in Figma.`);
    await waitForPluginConnection(
      runtime.bridge,
      waitMs,
      controller.signal,
      "the script was not submitted",
    );
    const bound = await targetForPluginCall(runtime.bridge, {
      document,
      fileKey,
      session,
      // Pairing is the `pair` command's: it reads the person's typed code, which a run whose stdin
      // may be a pipe or an agent's shell can't count on.
      pairing: { kind: "refuse" },
      signal: controller.signal,
      surface: "cli",
      waitMs,
      onWaiting: () => {
        console.error(GRANT_WAITING_TEXT);
        return async () => {};
      },
    });
    if (bound.kind === "blocked") throw new Error(bound.text);
    const { document: ran } = bound;
    console.error(`Running in "${ran.fileName}" (document ${ran.documentId}).`);
    const outcome = await executePluginCode(runtime, bound, code, {
      figma,
      signal: controller.signal,
    });
    if (outcome.kind === "refused") throw new Error(outcome.message);
    if (outcome.kind === "not-granted")
      throw new Error(notGrantedText(outcome.reason, ran.fileName));
    if (outcome.kind === "session-not-found")
      throw new Error(sessionNotFoundText(outcome.session, "cli"));
    try {
      const reply = {
        file: ran,
        session: outcome.session,
        ...withoutTokenMarks(outcome.reply),
      };
      const json = JSON.stringify(reply, null, 2) + "\n";
      process.stdout.write(json);
      if (flags.output) await writeFile(flags.output, json);
      if (reply.errors !== null) console.error(reply.errors);

      if (flags.screenshot) {
        // Its own execution: the script's id is spent on the run it named.
        const captured = await capturePluginScreenshot(
          runtime.bridge,
          { ...bound, executionId: mintExecutionId() },
          target,
          controller.signal,
        );
        if (captured.kind === "not-granted")
          throw new Error(
            "The script ran (its reply is above), but the plugin refused the screenshot (the grant " +
              "was revoked or the file got a new identity), so no PNG was saved. Re-running would " +
              "repeat the script's writes; report this to the user or coordinating agent instead.",
          );
        const screenshot = captured.reply;
        if ("errors" in screenshot) throw new Error(`Screenshot failed: ${screenshot.errors}`);
        await writeFile(flags.screenshot, Buffer.from(screenshot.image, "base64"));
      }
      return reply.errors === null ? 0 : 1;
    } finally {
      // Before stop(): a change the plugin reports after the reply is still charged to this run.
      awaitingSettlement = true;
      await runtime.writeMeter.drain(controller.signal, (remaining) => {
        console.error(
          `Execution finished. Keeping the relay connected for up to ${Math.ceil(remaining / 1000)}s to observe delayed document changes for write accounting.`,
        );
      });
      awaitingSettlement = false;
    }
  } catch (error) {
    if (signalExit !== undefined) {
      if (awaitingSettlement)
        console.error(
          "Interrupted while observing delayed document changes. The result was delivered, but late-write accounting could not be fully observed.",
        );
      return signalExit;
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    if (runtime.stop) runtime.stop();
    else runtime.bridge.stop();
  }
}
