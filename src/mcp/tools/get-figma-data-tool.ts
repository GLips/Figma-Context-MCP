// zod/v3, not "zod": this tool's schemas stay on the classic v3 API (the same classic
// implementation zod@4 still ships) across the workspace's zod-4 main-line bump; the MCP SDK
// accepts both. Migrating them to v4 is its own change, not a side effect of a dependency bump.
import { z } from "zod/v3";
import { FigmaService } from "~/services/figma.js";
import {
  FIGMA_NODE_ID_FORMAT_MESSAGE,
  FIGMA_NODE_ID_PATTERN,
  normalizeFigmaNodeId,
} from "~/utils/figma-url.js";
import { Logger } from "~/utils/logger.js";
import { sendProgress, startProgressHeartbeat, type ToolExtra } from "~/mcp/progress.js";
import {
  captureGetFigmaDataCall,
  type AuthMode,
  type ClientInfo,
  type Transport,
} from "~/telemetry/index.js";
import { getFigmaData as runGetFigmaData } from "~/services/get-figma-data.js";
import type { OutputFormat } from "~/utils/serialize.js";

const parameters = {
  fileKey: z
    .string()
    .regex(/^[a-zA-Z0-9]+$/, "File key must be alphanumeric")
    .describe(
      "The key of the Figma file to fetch, often found in a provided URL like figma.com/(file|design)/<fileKey>/...",
    ),
  nodeId: z
    .string()
    .regex(FIGMA_NODE_ID_PATTERN, FIGMA_NODE_ID_FORMAT_MESSAGE)
    .optional()
    .describe(
      "The ID of the node to fetch, often found as URL parameter node-id=<nodeId>, always use if provided. Use format '1234:5678' for a standard node, or 'I5666:180910;1:10515;1:10336' for a deeply nested instance node (the semicolon-joined path represents the instance override chain — it's still a single node ID, not multiple nodes).",
    ),
  depth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "How many levels of children to include. Only for when the user asks for a depth; the elided map is how to go deeper.",
    ),
};

const parametersSchema = z.object(parameters);
export type GetFigmaDataParams = z.infer<typeof parametersSchema>;

/**
 * Extra guidance for a failed read — how to get the same data another way — or null when there is
 * none. Supplied by the server when the plugin relay is running; the read tool knows nothing of it.
 */
export type DescribeReadRecovery = (error: unknown, request: { nodeId?: string }) => string | null;

async function getFigmaData(
  params: GetFigmaDataParams,
  figmaService: FigmaService,
  outputFormat: OutputFormat,
  transport: Transport,
  authMode: AuthMode,
  clientInfo: ClientInfo | undefined,
  describeRecovery: DescribeReadRecovery | undefined,
  extra: ToolExtra,
) {
  try {
    const { fileKey, nodeId: rawNodeId, depth } = parametersSchema.parse(params);

    const nodeId = rawNodeId && normalizeFigmaNodeId(rawNodeId);

    Logger.log(
      `Fetching ${depth ? `${depth} layers deep` : "all layers"} of ${
        nodeId ? `node ${nodeId} from file` : `full file`
      } ${fileKey}`,
    );

    let stopFetchHeartbeat: (() => Promise<void>) | undefined;
    let stopSimplifyHeartbeat: (() => Promise<void>) | undefined;

    const result = await runGetFigmaData(figmaService, { fileKey, nodeId, depth }, outputFormat, {
      onFetchStart: async () => {
        await sendProgress(extra, 0, 3, "Fetching design data from Figma API");
        stopFetchHeartbeat = startProgressHeartbeat(extra, "Waiting for Figma API response");
      },
      onFetchComplete: async () => {
        await stopFetchHeartbeat?.();
      },
      onSimplifyStart: async (progress) => {
        await sendProgress(extra, 1, 3, "Fetched design data, simplifying");
        stopSimplifyHeartbeat = startProgressHeartbeat(
          extra,
          () => `Simplifying design data (${progress.getNodeCount()} nodes processed)`,
        );
      },
      onSimplifyComplete: async () => {
        await stopSimplifyHeartbeat?.();
      },
      onSerializeStart: async () => {
        await sendProgress(extra, 2, 3, "Simplified design, serializing response");
      },
      onComplete: (outcome) =>
        captureGetFigmaDataCall(outcome, { transport, authMode, clientInfo }),
    });

    Logger.log(`Successfully extracted data: ${result.metrics.simplifiedNodeCount} nodes`);
    Logger.log("Sending result to client");

    return {
      content: [{ type: "text" as const, text: result.formatted }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    Logger.error(`Error fetching file ${params.fileKey}:`, message);
    const recovery = describeRecovery?.(error, {
      nodeId: params.nodeId && normalizeFigmaNodeId(params.nodeId),
    });
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Error fetching file: ${message}${recovery ? `\n\n${recovery}` : ""}`,
        },
      ],
    };
  }
}

// Export tool configuration
export const getFigmaDataTool = {
  name: "get_figma_data",
  description:
    "Read a Figma file or node as a simplified design tree: layout, text, styles, components and image references. Pass the node from the user's link; a whole file is large. A cut is listed in an elided field map with its size in JSON characters (null means a depth limit dropped it); fetch a node's cut children with the same fileKey and its nodeId. Hidden layers, vector paths and the shapes inside an icon collapsed to IMAGE-SVG are left out of every REST read, so fetching again won't recover them; the Framelink plugin reads them live. Figma annotations are not included (the REST API does not expose them).",
  parametersSchema,
  handler: getFigmaData,
} as const;
