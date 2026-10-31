// The one owner of a CLI command's process: it prepares the environment and telemetry, turns
// signals and closed output into the command's stop signal, maps how the command ended to an exit
// code, and ends the process (process-exit.ts). Commands only do their job and answer a code.
import { loadEnvFile, resolveCredential, resolveProxy, resolveTelemetryEnabled } from "~/config.js";
import { exitProcessAfterFlush } from "~/process-exit.js";
import type { FigmaCredential } from "~/services/figma.js";
import { initTelemetry } from "~/telemetry/index.js";
import { installFigmaProxyDispatcher } from "~/utils/figma-proxy-dispatcher.js";
import { createCliCommandContext, printCliFailure, type CliCommandContext } from "./cli-context.js";

/** The flags the runner reads from any command; a command declares the ones it takes. */
export type CliProcessFlags = {
  env?: string;
  noTelemetry?: boolean;
  figmaApiKey?: string;
  figmaOauthToken?: string;
  proxy?: string;
};

/** Why a command was told to stop, and the exit code that reports it when it didn't succeed. */
export class CliStop extends Error {
  constructor(
    readonly stoppedBy: "SIGINT" | "SIGTERM" | "output-failed",
    readonly exitCode: number,
  ) {
    super(stoppedBy === "output-failed" ? "Output failed" : `Stopped by ${stoppedBy}`);
    this.name = "CliStop";
  }
}

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;
// What a shell reports for a process killed by SIGPIPE, the usual end of `cmd | head`.
const OUTPUT_CLOSED_EXIT_CODE = 141;

/** Output that failed outweighs the command's own answer: what it printed didn't all arrive. */
function outputFailureExitCode(error: NodeJS.ErrnoException): number {
  return error.code === "EPIPE" ? OUTPUT_CLOSED_EXIT_CODE : 1;
}

/**
 * Everything a command's process needs before the command runs: the env file, the proxy every
 * outbound request takes (telemetry's too), the Figma credential, and telemetry, which is told the
 * credential before anything can be captured.
 */
export function prepareCliProcess(flags: CliProcessFlags): FigmaCredential | undefined {
  loadEnvFile(flags.env);
  installFigmaProxyDispatcher(resolveProxy(flags).value);
  const credential = resolveCredential(flags);
  initTelemetry({
    enabled: resolveTelemetryEnabled(flags.noTelemetry),
    redactFromTelemetry: credential ? [credential.token] : [],
  });
  return credential;
}

/** Run one command to its exit code, then end the process. Never returns. */
export async function runCliCommand(
  flags: CliProcessFlags,
  run: (context: CliCommandContext) => Promise<number>,
): Promise<never> {
  const stop = new AbortController();
  const onSignal = (signal: keyof typeof SIGNAL_EXIT_CODES) => {
    // A second signal means stop waiting for the command's cleanup.
    if (stop.signal.aborted) process.exit(SIGNAL_EXIT_CODES[signal]);
    stop.abort(new CliStop(signal, SIGNAL_EXIT_CODES[signal]));
  };
  // Without a listener, a write to a closed pipe (EPIPE) is an uncaught error. Kept until the exit:
  // the final flush can meet one too.
  let outputError: NodeJS.ErrnoException | undefined;
  const onOutputError = (error: NodeJS.ErrnoException) => {
    outputError ??= error;
    if (!stop.signal.aborted)
      stop.abort(new CliStop("output-failed", outputFailureExitCode(error)));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.stdout.on("error", onOutputError);
  process.stderr.on("error", onOutputError);

  let code: number;
  try {
    const credential = prepareCliProcess(flags);
    code = await run(createCliCommandContext({ signal: stop.signal, credential }));
  } catch (error) {
    // A command stopped mid-wait rejects with the stop itself; the exit code says so.
    code = stop.signal.aborted ? 1 : printCliFailure(error);
  }
  const reason: unknown = stop.signal.reason;
  if (code !== 0 && reason instanceof CliStop) code = reason.exitCode;
  return exitProcessAfterFlush(() => (outputError ? outputFailureExitCode(outputError) : code));
}
