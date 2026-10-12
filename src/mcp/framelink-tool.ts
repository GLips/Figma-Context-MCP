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
export type ToolCallObservation<Name extends string, Facts> =
  | { tool: Name; kind: "completed"; durationMs: number; isError: boolean; facts?: Facts }
  | { tool: Name; kind: "threw"; durationMs: number; error: unknown; facts?: Facts }
  | { tool: Name; kind: "rejected"; durationMs: number; rejection: ParamRejection };

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

  const run = async (params: ParamsOf<Input>, extra: ToolExtra): Promise<CallToolResult> => {
    const startedAt = Date.now();
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
      result = await def.handler(params, call, extra);
    } catch (error) {
      report({ tool: def.name, kind: "threw", durationMs: Date.now() - startedAt, error, facts });
      throw error;
    }
    const durationMs = Date.now() - startedAt;
    report(
      rejection
        ? { tool: def.name, kind: "rejected", durationMs, rejection }
        : { tool: def.name, kind: "completed", durationMs, isError: !!result.isError, facts },
    );
    return result;
  };

  const config = {
    title: def.title,
    description: def.description,
    annotations: def.annotations,
  };
  if (def.unknownParams === "strip")
    return server.registerTool(def.name, { ...config, inputSchema: def.inputSchema }, ((
      params: ParamsOf<Input>,
      extra: ToolExtra,
    ) => run(params, extra)) as never);

  // Loose rather than strict: `.strict()` makes the SDK throw its own fixed "Input validation
  // error", which names no key and reads as a broken tool. A loose parse lets the unknown key reach
  // us, so the reply is ours (fail-loud-params.ts).
  const shape = def.inputSchema as z.ZodRawShape;
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
          rejection: { field: unknown.join(","), rule: "unknown_param" },
        });
        return unknownParamsReply(def.name, unknown, known);
      }
      return run(args as ParamsOf<Input>, extra);
    },
  );
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
