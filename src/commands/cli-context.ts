// What a CLI command runs with, handed to it by the runner (cli-runner.ts): the process's stop
// signal, the Figma credential the runner resolved, and the way to record an operation exactly as
// its MCP twin records it.
import type { FigmaCredential } from "~/services/figma.js";
import { authMode, type ToolCallContext } from "~/telemetry/index.js";
import {
  observeOperation,
  type OperationCall,
  type OperationObservation,
} from "~/utils/observed-operation.js";

/** Turns one observation into telemetry: one of the `capture*Call` functions in telemetry/capture.ts. */
export type CaptureOperation<Name extends string, Facts> = (
  observation: OperationObservation<Name, Facts>,
  context: ToolCallContext,
) => void;

export interface CliCommandContext {
  /** Aborted when the command must stop: Ctrl-C, SIGTERM, or its output closed. */
  signal: AbortSignal;
  /** The Figma credential from the command's flags or the environment, already scrubbed from telemetry. */
  credential: FigmaCredential | undefined;
  /**
   * Run `perform` as one recorded operation, sending the event `capture` makes of it with transport
   * `cli`. Its exit code is its answer: nonzero is a failure. An expected failure is printed and
   * answered with a code; only a bug should throw out of `perform`. A throw once `signal` has
   * aborted is the stop itself, answered 1 (the runner reports the stop's own exit code).
   */
  observe<Name extends string, Facts>(
    tool: Name,
    capture: CaptureOperation<Name, Facts>,
    perform: (call: OperationCall<Facts>) => Promise<number>,
  ): Promise<number>;
}

export function createCliCommandContext({
  signal,
  credential,
}: {
  signal: AbortSignal;
  credential: FigmaCredential | undefined;
}): CliCommandContext {
  const caller: ToolCallContext = { transport: "cli", authMode: authMode(credential) };
  return {
    signal,
    credential,
    observe: <Name extends string, Facts>(
      tool: Name,
      capture: CaptureOperation<Name, Facts>,
      perform: (call: OperationCall<Facts>) => Promise<number>,
    ) =>
      observeOperation<Name, Facts, number>(
        {
          tool,
          observe: (observation) => capture(observation, caller),
          isError: (code: number) => code !== 0,
        },
        async (call) => {
          try {
            return await perform(call);
          } catch (error) {
            if (signal.aborted) return 1;
            throw error;
          }
        },
      ),
  };
}

/** Print a failure the way every command does, bare message on stderr, and answer exit code 1. */
export function printCliFailure(error: unknown): 1 {
  console.error(error instanceof Error ? error.message : String(error));
  return 1;
}
