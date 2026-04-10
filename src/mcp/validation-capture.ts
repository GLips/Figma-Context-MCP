import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  captureValidationReject,
  type ClientInfo,
  type Transport,
  type AuthMode,
} from "~/telemetry/index.js";

/**
 * The MCP SDK validates tool input against the registered zod schema BEFORE
 * calling our handler — failed validations bubble up as `McpError` and never
 * reach our code, so we can't observe them from inside the tool callback.
 *
 * To capture validation rejects we monkey-patch the McpServer instance's
 * `validateToolInput` method (private SDK API). Knowing exactly what shape of
 * tool call LLMs are getting wrong is one of the most actionable analytics
 * signals available — worth the small coupling cost. We patch the instance
 * (not the prototype) so concurrent McpServer instances in HTTP mode each
 * own their patched copy.
 *
 * Hardening notes:
 * - Fails open if `validateToolInput` ever disappears from the SDK — losing
 *   telemetry is preferable to crashing the server during creation.
 * - The second parse (used to extract structured field/rule info) runs inside
 *   its own try/catch so a future schema with side-effecting refinements can't
 *   corrupt the SDK's normal error response.
 * - Prefers `safeParseAsync` so async-aware schemas don't throw on sync parse.
 * - Normalizes numeric path segments to `[]` so `nodes.0.fileName` and
 *   `nodes.1.fileName` collapse to `nodes[].fileName` instead of inflating
 *   `validation_field` cardinality in PostHog.
 * - Replaces the SDK's noisy "MCP error -32602: Input validation error: ..."
 *   message with a clean, LLM-friendly version: "Invalid <field>: <message>".
 */
export function installValidationRejectCapture(
  server: McpServer,
  context: {
    transport: Transport;
    authMode: AuthMode;
    getClientInfo: () => ClientInfo | undefined;
  },
): void {
  type ZodIssue = {
    path?: Array<string | number>;
    code?: string;
    message?: string;
  };
  type SafeParseResult = { success: boolean; error?: { issues?: ZodIssue[] } };
  type ValidatableSchema = {
    safeParse?: (args: unknown) => SafeParseResult;
    safeParseAsync?: (args: unknown) => Promise<SafeParseResult>;
  };
  type ValidatedTool = { inputSchema?: ValidatableSchema };
  type Patchable = {
    validateToolInput?: (tool: ValidatedTool, args: unknown, toolName: string) => Promise<unknown>;
  };

  const patchable = server as unknown as Patchable;
  // Fail open if the SDK ever renames or removes this private method — we
  // lose validation reject telemetry, but the server still starts.
  if (typeof patchable.validateToolInput !== "function") {
    return;
  }
  const original = patchable.validateToolInput.bind(server);

  patchable.validateToolInput = async (tool, args, toolName) => {
    try {
      return await original(tool, args, toolName);
    } catch (error) {
      if (error instanceof McpError && error.code === ErrorCode.InvalidParams) {
        const issue = await extractIssue(tool, args);

        if (toolName === "get_figma_data" || toolName === "download_figma_images") {
          captureValidationReject(
            {
              tool: toolName,
              field: normalizeFieldPath(issue?.path),
              rule: issue?.code ?? "unknown",
              message: issue?.message ?? error.message,
            },
            {
              transport: context.transport,
              authMode: context.authMode,
              clientInfo: context.getClientInfo(),
            },
          );
        }

        // Replace the SDK's noisy "MCP error -32602: Input validation error:
        // Invalid arguments for tool ...: [{...JSON...}]" with a clean message
        // the LLM can act on. The SDK's createToolError uses error.message
        // regardless of error type, so a plain Error works fine here.
        if (issue) {
          throw new Error(`Invalid ${normalizeFieldPath(issue.path)}: ${issue.message}`);
        }
      }
      throw error;
    }
  };
}

type ZodIssue = {
  path?: Array<string | number>;
  code?: string;
  message?: string;
};

/**
 * Best-effort structured issue extraction. Prefers `safeParseAsync` to align
 * with how the SDK validates — async schemas (refinements/transforms) need it.
 * Wrapped in try/catch so a future schema with side effects can't corrupt the
 * SDK's normal error response.
 */
async function extractIssue(
  tool: {
    inputSchema?: {
      safeParse?: (args: unknown) => { success: boolean; error?: { issues?: ZodIssue[] } };
      safeParseAsync?: (
        args: unknown,
      ) => Promise<{ success: boolean; error?: { issues?: ZodIssue[] } }>;
    };
  },
  args: unknown,
): Promise<ZodIssue | undefined> {
  try {
    const schema = tool.inputSchema;
    if (schema?.safeParseAsync) {
      const result = await schema.safeParseAsync(args);
      if (!result.success) return result.error?.issues?.[0];
    } else if (schema?.safeParse) {
      const result = schema.safeParse(args);
      if (!result.success) return result.error?.issues?.[0];
    }
  } catch {
    // The second parse can throw if a future schema has side-effecting
    // refinements. Falling back loses field/rule precision but keeps the
    // SDK's normal error response intact for the client.
  }
  return undefined;
}

/**
 * Render a zod error path with array indexes collapsed to `[]`. Without this,
 * `nodes.0.fileName` / `nodes.1.fileName` would explode validation_field
 * cardinality with no analytical value.
 */
export function normalizeFieldPath(path: Array<string | number> | undefined): string {
  if (!path || path.length === 0) return "(root)";
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += "[]";
    } else {
      out += out.length > 0 ? "." + segment : segment;
    }
  }
  return out;
}
