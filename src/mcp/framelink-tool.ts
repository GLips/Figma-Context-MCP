// The one way a tool joins a Framelink MCP server, read or write. It owns what every tool must have
// wired: an observation of each call (timing, error, schema rejects, tool-specific facts), and an
// explicit choice of what an unknown parameter does. What an observation becomes — PostHog events
// locally, sanitized observations for the embeddable read entry — is the composition's call.
//
// Nothing here may import `~/commercial/` or telemetry: the read entry's import graph runs through
// this module (scripts/check-read-entry.mjs).
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  AnySchema,
  SchemaOutput,
  ShapeOutput,
  ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { z as z3 } from "zod/v3";
import { unknownParamsReply } from "./fail-loud-params.js";
import type { ToolExtra } from "./progress.js";
import { installValidationRejectCapture, type ParamRejection } from "./validation-capture.js";

export type { ParamRejection };

/**
 * What a tool does with a parameter its schema doesn't name. `strip`: the SDK drops it silently, and
 * the advertised JSON Schema stays closed. `fail-loud`: the call doesn't run and the agent gets a
 * retryable reply naming the key (fail-loud-params.ts) — needs a zod 4 raw shape.
 */
export type UnknownParamPolicy = "strip" | "fail-loud";

type ToolInput = ZodRawShapeCompat | AnySchema;
type ParamsOf<Input extends ToolInput> = Input extends ZodRawShapeCompat
  ? ShapeOutput<Input>
  : Input extends AnySchema
    ? SchemaOutput<Input>
    : never;

/** One call's handle on its own observation. */
export interface FramelinkToolCall<Facts> {
  /** The tool-specific facts this call's observation carries; the last recorded wins. */
  record(facts: Facts): void;
  /** The arguments failed a check the schema can't express; the handler still answers the agent. */
  reject(rejection: ParamRejection): void;
}

/**
 * How one call ended. `completed`: the handler answered (`isError` as it said). `threw`: the
 * handler threw — every expected failure is answered as a result, so a throw is a bug or an outage
 * nobody anticipated. `rejected`: the arguments failed validation and the tool's work never ran.
 */
export type ToolCallObservation<Name extends string, Facts> = {
  tool: Name;
  durationMs: number;
  /** What the agent said the call is for, verbatim — free text. Absent when it said nothing. */
  intent?: string;
} & (
  | { kind: "completed"; isError: boolean; facts?: Facts }
  | { kind: "threw"; error: unknown; facts?: Facts }
  | { kind: "rejected"; rejection: ParamRejection }
);

export interface FramelinkToolDef<Name extends string, Input extends ToolInput, Facts> {
  name: Name;
  title?: string;
  description: string;
  inputSchema: Input;
  unknownParams: Input extends z.ZodRawShape ? UnknownParamPolicy : "strip";
  annotations?: ToolAnnotations;
  handler: (
    params: ParamsOf<Input>,
    call: FramelinkToolCall<Facts>,
    extra: ToolExtra,
  ) => Promise<CallToolResult>;
}

/** Where a tool's observations go. Throwing here never affects the call. */
export type ObserveToolCall<Name extends string, Facts> = (
  observation: ToolCallObservation<Name, Facts>,
) => void;

const USER_GOAL_PARAM = "userGoal";
const USER_GOAL_DESCRIPTION =
  "Optional. One short line on what the user is trying to get done, in your own words, e.g. " +
  '"Build the pricing page from this design". Sent with anonymous usage analytics to show what ' +
  "Framelink is used for; never include secrets or personal details.";

// Servers whose tools advertise the param; see askAgentsForUserGoal.
const userGoalServers = new WeakSet<McpServer>();

/**
 * Makes every tool registered on `server` from now on take an optional `userGoal`, read and stripped
 * before the handler runs. A composition asks only when something records the answer (telemetry
 * on): otherwise the param is tokens in every tool list for nothing. Must run before the tools are
 * registered.
 *
 * Not the write tools' `intent`: that names this one step for the human watching the plugin panel;
 * the goal is the user's whole aim, which is what intent analytics groups by.
 */
export function askAgentsForUserGoal(server: McpServer): void {
  userGoalServers.add(server);
}

// Per server: the observer each registered tool's schema rejects go to.
const schemaRejectObservers = new WeakMap<
  McpServer,
  Map<string, (rejection: ParamRejection) => void>
>();

export function registerFramelinkTool<Name extends string, Input extends ToolInput, Facts>(
  server: McpServer,
  def: FramelinkToolDef<Name, Input, Facts>,
  // NoInfer: the tool's own handler fixes Facts; a composition's observer may take a wider union.
  observe: NoInfer<ObserveToolCall<Name, Facts>>,
): RegisteredTool {
  const report = (observation: ToolCallObservation<Name, Facts>) => {
    try {
      observe(observation);
    } catch {
      // An observer must never turn a finished call into a failed one.
    }
  };
  schemaRejectObserversOf(server).set(def.name, (rejection) =>
    report({ tool: def.name, kind: "rejected", durationMs: 0, rejection }),
  );

  const asksUserGoal = userGoalServers.has(server);

  const run = async (args: Record<string, unknown>, extra: ToolExtra): Promise<CallToolResult> => {
    const startedAt = Date.now();
    const { [USER_GOAL_PARAM]: userGoal, ...params } = args;
    const intent = asksUserGoal ? statedIntent(userGoal) : undefined;
    let facts: Facts | undefined;
    let rejection: ParamRejection | undefined;
    const call: FramelinkToolCall<Facts> = {
      record: (recorded) => {
        facts = recorded;
      },
      reject: (rejected) => {
        rejection = rejected;
      },
    };
    let result: CallToolResult;
    try {
      result = await def.handler(params as ParamsOf<Input>, call, extra);
    } catch (error) {
      report({
        tool: def.name,
        kind: "threw",
        durationMs: Date.now() - startedAt,
        intent,
        error,
        facts,
      });
      throw error;
    }
    const durationMs = Date.now() - startedAt;
    report(
      rejection
        ? { tool: def.name, kind: "rejected", durationMs, intent, rejection }
        : {
            tool: def.name,
            kind: "completed",
            durationMs,
            intent,
            isError: !!result.isError,
            facts,
          },
    );
    return result;
  };

  const config = {
    title: def.title,
    description: def.description,
    annotations: def.annotations,
  };
  const inputSchema = asksUserGoal ? withUserGoalParam(def.inputSchema) : def.inputSchema;
  if (def.unknownParams === "strip")
    return server.registerTool(def.name, { ...config, inputSchema }, ((
      args: Record<string, unknown>,
      extra: ToolExtra,
    ) => run(args, extra)) as never);

  // Loose rather than strict: `.strict()` makes the SDK throw its own fixed "Input validation
  // error", which names no key and reads as a broken tool. A loose parse lets the unknown key reach
  // us, so the reply is ours (fail-loud-params.ts).
  const shape = inputSchema as z.ZodRawShape;
  const known = Object.keys(shape);
  return server.registerTool(
    def.name,
    { ...config, inputSchema: z.looseObject(shape) },
    async (args: Record<string, unknown>, extra: ToolExtra) => {
      const unknown = Object.keys(args).filter((key) => !known.includes(key));
      if (unknown.length) {
        report({
          tool: def.name,
          kind: "rejected",
          durationMs: 0,
          intent: asksUserGoal ? statedIntent(args[USER_GOAL_PARAM]) : undefined,
          rejection: { field: unknown.join(","), rule: "unknown_param" },
        });
        return unknownParamsReply(def.name, unknown, known);
      }
      return run(args, extra);
    },
  );
}

/** An agent's free text, trimmed; blank or not a string is no intent at all. */
function statedIntent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

/**
 * The tool's input with `userGoal` added, built in the zod major the input already uses: the SDK
 * picks one zod implementation per schema, so a v4 field inside a v3 shape would not validate.
 * Optional, so a call without it runs exactly as before.
 */
function withUserGoalParam(input: ToolInput): ToolInput {
  const isV4 = (schema: object) => "_zod" in schema;
  // `.catch`: an analytics-only param must never fail the user's real call, so a goal of the wrong
  // type is dropped instead of rejected. The advertised schema still says string.
  const v4Field = () => z.string().optional().catch(undefined).describe(USER_GOAL_DESCRIPTION);
  const v3Field = () => z3.string().optional().catch(undefined).describe(USER_GOAL_DESCRIPTION);
  if (input instanceof z.ZodObject) return input.extend({ [USER_GOAL_PARAM]: v4Field() });
  if (input instanceof z3.ZodObject) return input.extend({ [USER_GOAL_PARAM]: v3Field() });
  const fields = Object.values(input as Record<string, object>);
  const field = fields.length === 0 || fields.some(isV4) ? v4Field() : v3Field();
  return { ...input, [USER_GOAL_PARAM]: field } as ToolInput;
}

function schemaRejectObserversOf(
  server: McpServer,
): Map<string, (rejection: ParamRejection) => void> {
  let observers = schemaRejectObservers.get(server);
  if (!observers) {
    const created = new Map<string, (rejection: ParamRejection) => void>();
    installValidationRejectCapture(server, (tool, rejection) => created.get(tool)?.(rejection));
    schemaRejectObservers.set(server, created);
    observers = created;
  }
  return observers;
}
