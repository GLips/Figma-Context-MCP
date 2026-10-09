/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { type Command, command } from "cleye";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { loadEnvFile, resolvePluginConfig, UsageError } from "~/config.js";
import { startPluginBridge, type PluginBridgeRuntime } from "~/commercial/plugin-bridge/index.js";
import {
  executePluginCode,
  capturePluginScreenshot,
} from "~/commercial/plugin-bridge/execution.js";
import {
  MAX_SCREENSHOT_SCALE,
  screenshotInputError,
} from "~/commercial/plugin-bridge/screenshot-options.js";
import { buildQuickStart } from "~/commercial/tools/flcm-docs/reference.js";
import { CLI_DOCS_CHANNEL } from "~/commercial/tools/flcm-docs/channels.js";
import { buildCommandHelp } from "~/utils/cli-help.js";

const DEFAULT_WAIT_SECONDS = 600;

export const executeCommand: Command = command(
  {
    name: "execute",
    strictFlags: true,
    parameters: ["<script>"],
    help: buildCommandHelp({
      name: "execute",
      summary: "Run an flcm script in the Figma file the Framelink plugin has open",
      details: `The script is the body of an async function: use await and return directly, with no imports or
exports. Open the Framelink plugin in the target file first; the first run waits for you to approve
the pairing code printed to stderr. No Figma API token is needed.

stdout gets the reply as JSON, { result, console, errors }; progress goes to stderr. Exits 0 when
errors is null, 1 on a script, connection or approval failure, 130 on Ctrl-C. A run is never
resubmitted automatically.`,
      exampleArgs: [
        "card.js",
        "card.js --output out/reply.json --screenshot out/card.png --key card --scale 2",
      ],
      // After the flags because it is what the script file needs; its FULL DOCS line is the next
      // disclosure step, into `reference`.
      appendix: [{ title: "Writing the script:", body: buildQuickStart(CLI_DOCS_CHANNEL) }],
    }),
    flags: {
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
      wait: {
        type: Number,
        placeholder: "<seconds>",
        description: `Wait this long for the plugin to connect, and again for each approval (default ${DEFAULT_WAIT_SECONDS}; 0 fails at once)`,
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
  output?: string;
  screenshot?: string;
  nodeId?: string;
  key?: string;
  scale?: number;
  wait?: number;
  assetRoot?: string;
  env?: string;
}

/** CLI file/stdio boundary. Execution and image policy live in the shared plugin services. */
export async function runExecute(flags: ExecuteFlags, positionals: string[]): Promise<number> {
  if (positionals.length !== 1 || extname(positionals[0]) !== ".js") {
    throw new UsageError("execute requires one .js file containing an async function body.");
  }
  const waitMs = (flags.wait ?? DEFAULT_WAIT_SECONDS) * 1000;
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 2_147_483_647) {
    throw new UsageError(
      "--wait must be a finite, nonnegative number of seconds within the timer range.",
    );
  }
  const target = { nodeId: flags.nodeId, key: flags.key, scale: flags.scale };
  const inputError = screenshotInputError(target);
  if (inputError) throw new UsageError(inputError);
  if (!flags.screenshot && Object.values(target).some((value) => value !== undefined)) {
    throw new UsageError("--node-id, --key, and --scale require --screenshot <file.png>.");
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

  const config = resolvePluginConfig(flags.assetRoot);
  const runtime = startPluginBridge({
    assetRoot: config.assetRoot.value,
    framelinkApiUrl: config.framelinkApiUrl.value,
  });
  runtime.onFirstConnect(() =>
    console.error(`Figma connected. Pairing code: ${runtime.bridge.getPairingCode()}.`),
  );
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
    await waitForPlugin(runtime, waitMs, controller.signal);
    const options = {
      waitMs,
      signal: controller.signal,
      onWaiting: () => {
        console.error(
          `Waiting for approval in Figma (pairing code ${runtime.bridge.getPairingCode()}); code has not been submitted.`,
        );
        return async () => {};
      },
    };
    const outcome = await executePluginCode(runtime, code, options);
    if (outcome.kind === "refused") throw new Error(outcome.message);
    if (outcome.kind === "pending") {
      throw new Error(
        `Approval timed out; the script did not run. Approve session ${runtime.bridge.getPairingCode()} in Figma and retry.`,
      );
    }
    try {
      const reply = outcome.reply;
      const json = JSON.stringify(reply, null, 2) + "\n";
      process.stdout.write(json);
      if (flags.output) await writeFile(flags.output, json);
      if (reply.errors !== null) console.error(reply.errors);

      if (flags.screenshot) {
        const captured = await capturePluginScreenshot(runtime.bridge, target, options);
        if (captured.kind === "pending")
          throw new Error("Screenshot approval timed out; no PNG was saved.");
        const screenshot = captured.reply;
        if ("errors" in screenshot) throw new Error(`Screenshot failed: ${screenshot.errors}`);
        await writeFile(flags.screenshot, Buffer.from(screenshot.image, "base64"));
      }
      return reply.errors === null ? 0 : 1;
    } finally {
      if (outcome.settlementRunId) {
        awaitingSettlement = true;
        await runtime.writeAccess.waitForWriteSettlement(
          outcome.settlementRunId,
          controller.signal,
          (remaining) => {
            console.error(
              `Execution finished. Keeping the relay connected for up to ${Math.ceil(remaining / 1000)}s to observe delayed document changes for write accounting.`,
            );
          },
        );
      }
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

function waitForPlugin(
  runtime: PluginBridgeRuntime,
  waitMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (runtime.bridge.isPluginConnected()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal.reason);
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "No Figma plugin connected before --wait expired. Open the Framelink plugin in the intended Figma file and retry.",
          ),
        ),
      waitMs,
    );
    signal.addEventListener("abort", abort, { once: true });
    runtime.onFirstConnect(() => finish());
  });
}
