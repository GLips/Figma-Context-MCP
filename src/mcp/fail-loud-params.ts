import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * Register a tool whose UNKNOWN params fail loud instead of being silently dropped — ADR-0003's
 * fail-loud ethos ("reject rather than approximate") moved one layer out from the DSL to the MCP
 * boundary.
 *
 * Why this exists: the SDK wraps a tool's raw param shape in a plain zod object, which **strips**
 * unknown keys before the handler ever sees them (`objectFromShape` → `z4mini.object`, then
 * `validateToolInput`; @modelcontextprotocol/sdk@1.29.0). An agent that typed `node_id` for `nodeId`
 * therefore got a *successful* whole-page screenshot, concluded node-targeting was impossible, and
 * built an elaborate workaround. One loud error would have cost it one retry.
 *
 * Why the schema is LOOSE rather than strict: `.strict()` at registration makes the SDK's own
 * `validateToolInput` throw `McpError(InvalidParams)`, which the dispatch `catch` auto-shapes into a
 * terminal `isError: true` result with fixed wording ("Input validation error: …") — no offending key
 * named, no suggestion, and read by agents as "this tool is broken". A loose object instead lets the
 * unknown key survive the parse and reach the handler, where we own the reply: a RETRYABLE
 * (non-`isError`) message naming the bad key, modelled on the approval gate's "this is NOT a failure"
 * wording so the agent corrects the name rather than abandoning the tool.
 *
 * The known-key set is derived from the tool's own shape, so it can never drift from the schema.
 *
 * Negative space: the read tools (`get_figma_data`, `download_figma_images`) still use plain
 * `server.registerTool` and still strip. Adopting this there flips their advertised JSON Schema to
 * `additionalProperties: {}` for every published client — a deliberate call for its own change, not a
 * drive-by.
 */
export function registerFailLoudTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  config: { description: string; inputSchema: Shape },
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>,
): RegisteredTool {
  const known = Object.keys(config.inputSchema);
  return server.registerTool(
    name,
    { description: config.description, inputSchema: z.looseObject(config.inputSchema) },
    // The intersection IS the loose parse's output: the tool's own params plus whatever unknown keys
    // survived — so the filter below has something to read and the handler takes `args` unchanged.
    async (args: z.infer<z.ZodObject<Shape>> & Record<string, unknown>) => {
      const unknown = Object.keys(args).filter((key) => !known.includes(key));
      if (unknown.length) return unknownParamReply(name, unknown, known);
      return handler(args);
    },
  );
}

/**
 * A tool reply that says "this call did not run; fix the call and retry" — deliberately NOT `isError`.
 * An agent that reads a terminal failure abandons the tool (exactly the over-reaction this whole
 * surface exists to prevent); one that reads a retryable correction just calls again with the fix.
 * The shared shape for every param-level rejection: unknown keys here, value-level checks in handlers.
 */
export function retryableToolReply(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function unknownParamReply(tool: string, unknown: string[], known: string[]): CallToolResult {
  const several = unknown.length > 1;
  const named = unknown.map((k) => `"${k}"`).join(", ");
  const suggestions = unknown.flatMap((bad) => {
    const match = known.find((k) => normalizeParamName(k) === normalizeParamName(bad));
    if (!match) return [];
    // With one bad key the pairing is obvious from the sentence; with several, spell out which is which.
    return several ? `"${bad}" → "${match}"` : `"${match}"`;
  });
  const didYouMean = suggestions.length ? ` Did you mean ${suggestions.join(", ")}?` : "";
  const valid = `Valid parameter${known.length > 1 ? "s" : ""}: ${known.join(", ")}.`;
  return retryableToolReply(
    `${tool} received unknown parameter${several ? "s" : ""} ${named}, so this call did not run.` +
      `${didYouMean} ${valid} This is NOT a failure: retry this exact call with the parameter ` +
      `name${several ? "s" : ""} corrected.`,
  );
}

/** Case/separator-insensitive form, so the common `node_id`/`NodeID`-for-`nodeId` slip resolves to a suggestion. */
function normalizeParamName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}
