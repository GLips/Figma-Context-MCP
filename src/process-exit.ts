import { closeTelemetry } from "./telemetry/index.js";

// The longest telemetry may hold a process's exit: a network that silently drops packets would
// otherwise keep delivery, and its retries, alive after the work is done. Events that miss it are
// dropped.
const TELEMETRY_EXIT_BUDGET_MS = 1500;

/**
 * The one way a Framelink process ends once its work is done, the server's shutdown and every CLI
 * command alike: telemetry gets its budget, then everything written to stdout and stderr is handed
 * to the OS, then the process exits with `code` whatever handles are still open.
 */
export async function exitProcessAfterFlush(code: number): Promise<never> {
  await closeTelemetry(TELEMETRY_EXIT_BUDGET_MS);
  await Promise.all([flushOutput(process.stdout), flushOutput(process.stderr)]);
  process.exit(code);
}

// An empty write's callback runs once every earlier write has been handed off, or failed: a pipe
// whose reader is gone answers EPIPE, and that is as done as the output gets.
function flushOutput(stream: NodeJS.WriteStream): Promise<void> {
  if (stream.destroyed || !stream.writable) return Promise.resolve();
  return new Promise((resolve) => {
    stream.write("", () => resolve());
  });
}
