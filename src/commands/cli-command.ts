// How a command joins the CLI: its cleye definition plus `run(argv, context) → exit code`. The
// adapter gives every command the process-wide flags and makes its cleye callback hand the parsed
// argv to the runner (cli-runner.ts), which owns the process from there. It has to be the callback:
// cleye runs it inside `cli()`, before anything wrapping `cli()` could step in.
import { command, type Command } from "cleye";
import type { CliCommandContext } from "./cli-context.js";
import { runCliCommand, type CliProcessFlags } from "./cli-runner.js";

/** Flags every command takes, read by the runner rather than the command. */
export const CLI_PROCESS_FLAGS = {
  env: {
    type: String,
    placeholder: "<file>",
    description: "Load environment variables from this file (default ./.env)",
  },
  noTelemetry: {
    type: Boolean,
    description: "Turn off usage telemetry (env FRAMELINK_TELEMETRY=off or DO_NOT_TRACK=1)",
  },
} as const;

type ArgvOf<C extends Command> = C extends Command<C["options"], infer Parsed> ? Parsed : never;

/**
 * A CLI command: `definition` is `command({...})` without a callback, so cleye infers the argv
 * `run` receives. Returns the cleye command `cli()` takes.
 */
export function defineCliCommand<C extends Command>(
  definition: C,
  run: (argv: ArgvOf<C>, context: CliCommandContext) => Promise<number>,
): Command {
  const { options } = definition;
  return command(
    { ...options, flags: { ...options.flags, ...CLI_PROCESS_FLAGS } },
    (argv) =>
      void runCliCommand(argv.flags as CliProcessFlags, (context) =>
        run(argv as ArgvOf<C>, context),
      ),
  );
}
