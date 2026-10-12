import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

/**
 * A call whose arguments failed a check, named by the field and rule it broke — codes, never the
 * check's message, which can quote what the agent sent.
 */
export type ParamRejection = { field: string; rule: string; detail?: string };

/**
 * The MCP SDK validates tool input against the registered zod schema BEFORE calling our handler —
 * failed validations bubble up as `McpError` and never reach our code, so we can't observe them
 * from inside the tool callback.
 *
 * So the McpServer instance's `validateToolInput` (private SDK API) is patched, once per server, to
 * hand each schema reject to `onReject` with the tool's name. Knowing exactly what shape of tool
 * call LLMs get wrong is one of the most actionable analytics signals available — worth the small
 * coupling cost. The instance, not the prototype, is patched so concurrent servers in HTTP mode
 * each own their copy.
 *
 * Hardening notes:
 * - Fails open if `validateToolInput` ever disappears from the SDK — losing the rejects is
 *   preferable to crashing the server during creation.
 * - The second parse (for structured field/rule info) runs inside its own try/catch, so a future
 *   schema with side-effecting refinements can't corrupt the SDK's normal error response.
 * - Numeric path segments collapse to `[]`, so `nodes.0.fileName` and `nodes.1.fileName` are one
 *   field.
 * - Replaces the SDK's noisy "MCP error -32602: Input validation error: ..." with a clean,
 *   LLM-friendly "Invalid <field>: <message>".
 */
export function installValidationRejectCapture(
  server: McpServer,
  onReject: (toolName: string, rejection: ParamRejection) => void,
): void {
  const patchable = server as unknown as Patchable;
  if (typeof patchable.validateToolInput !== "function") return;
  const original = patchable.validateToolInput.bind(server);

  patchable.validateToolInput = async (tool, args, toolName) => {
    try {
      return await original(tool, args, toolName);
    } catch (error) {
      if (error instanceof McpError && error.code === ErrorCode.InvalidParams) {
        const issue = await extractIssue(tool, args);
        const field = normalizeFieldPath(issue?.path);
        onReject(toolName, { field, rule: issue?.code ?? "unknown" });
        // The SDK's createToolError uses error.message regardless of error type, so a plain Error
        // replaces its noisy wording.
        if (issue) throw new Error(`Invalid ${field}: ${issue.message}`);
      }
      throw error;
    }
  };
}

// The slice of the SDK's private tool/schema shapes this patch touches.
type ZodIssue = { path?: Array<string | number>; code?: string; message?: string };
type SafeParseResult = { success: boolean; error?: { issues?: ZodIssue[] } };
type ValidatedTool = {
  inputSchema?: {
    safeParse?: (args: unknown) => SafeParseResult;
    safeParseAsync?: (args: unknown) => Promise<SafeParseResult>;
  };
};
type Patchable = {
  validateToolInput?: (tool: ValidatedTool, args: unknown, toolName: string) => Promise<unknown>;
};

/** Prefers `safeParseAsync`, as the SDK does: async refinements and transforms need it. */
async function extractIssue(tool: ValidatedTool, args: unknown): Promise<ZodIssue | undefined> {
  try {
    const schema = tool.inputSchema;
    const result = schema?.safeParseAsync
      ? await schema.safeParseAsync(args)
      : schema?.safeParse?.(args);
    if (result && !result.success) return result.error?.issues?.[0];
  } catch {
    // Falling back loses field/rule precision but keeps the SDK's normal error response intact.
  }
  return undefined;
}

/** A zod error path with array indexes collapsed to `[]`, so per-index fields don't multiply. */
export function normalizeFieldPath(path: Array<string | number> | undefined): string {
  if (!path || path.length === 0) return "(root)";
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += "[]";
    else out += out.length > 0 ? "." + segment : segment;
  }
  return out;
}
