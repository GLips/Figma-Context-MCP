import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// The replies behind `unknownParams: "fail-loud"` (framelink-tool.ts): an unknown param fails loud
// instead of being silently dropped — ADR-0003's fail-loud ethos ("reject rather than approximate")
// moved one layer out from the DSL to the MCP boundary.
//
// Why: the SDK wraps a tool's raw param shape in a plain zod object, which **strips** unknown keys
// before the handler ever sees them (`objectFromShape` → `z4mini.object`, then `validateToolInput`;
// @modelcontextprotocol/sdk@1.29.0). An agent that typed `node_id` for `nodeId` therefore got a
// *successful* whole-page screenshot, concluded node-targeting was impossible, and built an
// elaborate workaround. One loud error would have cost it one retry.
//
// Negative space: the read tools still strip. Failing loud there flips their advertised JSON Schema
// to `additionalProperties: {}` for every published client — a deliberate call for its own change.

/**
 * A tool reply that says "this call did not run; fix the call and retry" — deliberately NOT `isError`.
 * An agent that reads a terminal failure abandons the tool (exactly the over-reaction this whole
 * surface exists to prevent); one that reads a retryable correction just calls again with the fix.
 * The shared shape for every param-level rejection: unknown keys here, value-level checks in handlers.
 */
export function retryableToolReply(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/** A retryable reply naming the unknown keys, with a did-you-mean where one is a near miss. */
export function unknownParamsReply(
  tool: string,
  unknown: string[],
  known: string[],
): CallToolResult {
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
