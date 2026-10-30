// One observed operation, whatever runs it: an MCP tool call (mcp/framelink-tool.ts) or a CLI
// command (commands/cli-command.ts). It times the work, collects the facts the work records, and
// hands one observation to whoever listens. What an observation becomes (a PostHog event, a
// sanitized log line) is the listener's call.
//
// Nothing here may import MCP, telemetry or `~/commercial/`: the embeddable read entry's import
// graph runs through this module (scripts/check-read-entry.mjs).

/**
 * A call whose arguments failed a check, named by the field and rule it broke — codes, never the
 * check's message, which can quote what the caller sent.
 */
export type ParamRejection = { field: string; rule: string; detail?: string };

/** One operation's handle on its own observation. */
export interface OperationCall<Facts> {
  /** The operation-specific facts this observation carries; the last recorded wins. */
  record(facts: Facts): void;
  /** The arguments failed a check a schema can't express; the operation still answers. */
  reject(rejection: ParamRejection): void;
  /**
   * The operation outlives its answer: it really ends when `ended` settles (a plugin run a tool
   * call checked in on), so its one observation waits for that and carries `ended`'s outcome, its
   * duration counted to then. A rejection of `ended` is observed as `threw`, with the facts
   * recorded by then.
   */
  completeLater(ended: Promise<{ isError: boolean; facts: Facts }>): void;
}

/**
 * How one operation ended. `completed`: it answered (`isError` as it said). `threw`: it threw —
 * every expected failure is answered, so a throw is a bug or an outage nobody anticipated.
 * `rejected`: the arguments failed validation and the work never ran.
 */
export type OperationObservation<Name extends string, Facts> = {
  /** The operation's name: an MCP tool's, or a CLI-only command's own. */
  tool: Name;
  durationMs: number;
  /** What the caller said the operation is for, verbatim — free text. Absent when it said nothing. */
  intent?: string;
} & (
  | { kind: "completed"; isError: boolean; facts?: Facts }
  | { kind: "threw"; error: unknown; facts?: Facts }
  | { kind: "rejected"; rejection: ParamRejection }
);

/** Where observations go. Throwing here never affects the operation. */
export type ObserveOperation<Name extends string, Facts> = (
  observation: OperationObservation<Name, Facts>,
) => void;

/** `observe`, made safe to call from inside an operation: a listener's throw is swallowed. */
export function reportingTo<Name extends string, Facts>(
  observe: ObserveOperation<Name, Facts>,
): ObserveOperation<Name, Facts> {
  return (observation) => {
    try {
      observe(observation);
    } catch {
      // A listener must never turn a finished operation into a failed one.
    }
  };
}

/**
 * Run `perform` as one observed operation and return what it returned. A throw is observed as
 * `threw` and rethrown; a recorded rejection wins over the result; an operation that completes
 * later (`completeLater`) is observed when it does; otherwise `isError(result)` says whether the
 * answer was a failure. Exactly one observation per operation, whichever way it ends.
 */
export async function observeOperation<Name extends string, Facts, Result>(
  {
    tool,
    intent,
    observe,
    isError,
  }: {
    tool: Name;
    intent?: string;
    observe: ObserveOperation<Name, Facts>;
    isError: (result: Result) => boolean;
  },
  perform: (call: OperationCall<Facts>) => Promise<Result>,
): Promise<Result> {
  const report = reportingTo(observe);
  const startedAt = Date.now();
  let facts: Facts | undefined;
  let rejection: ParamRejection | undefined;
  let ended: Promise<{ isError: boolean; facts: Facts }> | undefined;
  const call: OperationCall<Facts> = {
    record: (recorded) => {
      facts = recorded;
    },
    reject: (rejected) => {
      rejection = rejected;
    },
    completeLater: (completion) => {
      ended = completion;
    },
  };
  let result: Result;
  try {
    result = await perform(call);
  } catch (error) {
    report({ tool, kind: "threw", durationMs: Date.now() - startedAt, intent, error, facts });
    throw error;
  }
  const durationMs = Date.now() - startedAt;
  if (rejection) report({ tool, kind: "rejected", durationMs, intent, rejection });
  else if (ended)
    ended.then(
      (end) =>
        report({ tool, kind: "completed", durationMs: Date.now() - startedAt, intent, ...end }),
      (error: unknown) =>
        report({ tool, kind: "threw", durationMs: Date.now() - startedAt, intent, error, facts }),
    );
  else report({ tool, kind: "completed", durationMs, intent, isError: isError(result), facts });
  return result;
}
