// zod/v3, not "zod": this tool's schemas stay on the classic v3 API (the same classic
// implementation zod@4 still ships) across the workspace's zod-4 main-line bump; the MCP SDK
// accepts both. Migrating them to v4 is its own change, not a side effect of a dependency bump.
import { z } from "zod/v3";
import { FigmaService } from "~/services/figma.js";
import { FIGMA_NODE_ID_PATTERN } from "@framelink/core";
import { FIGMA_NODE_ID_FORMAT_MESSAGE, normalizeFigmaNodeId } from "~/utils/figma-url.js";
import { Logger } from "~/utils/logger.js";
import { sendProgress, startProgressHeartbeat, type ToolExtra } from "~/mcp/progress.js";
import {
  getFigmaData as runGetFigmaData,
  type GetFigmaDataOutcome,
  type GetFigmaDataPhase,
} from "~/services/get-figma-data.js";
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
  {
    outputFormat,
    describeRecovery,
    onComplete,
    extra,
  }: {
    outputFormat: OutputFormat;
    describeRecovery: DescribeReadRecovery | undefined;
    onComplete: (outcome: GetFigmaDataOutcome) => void;
    extra: ToolExtra;
  },
) {
  try {
    const { fileKey, nodeId: rawNodeId, depth } = parametersSchema.parse(params);

    const nodeId = rawNodeId && normalizeFigmaNodeId(rawNodeId);

    Logger.log(
      `Fetching ${depth ? `${depth} layers deep` : "all layers"} of ${
        nodeId ? `node ${nodeId} from file` : `full file`
      } ${fileKey}`,
    );

    // One heartbeat per phase that can run long: two of them wait on Figma, one on the walk.
    const steps: Partial<Record<GetFigmaDataPhase, [step: number, message: string]>> = {
      fetch: [0, "Fetching design data from Figma API"],
      enrich: [1, "Fetching component definitions"],
      simplify: [2, "Simplifying design data"],
      serialize: [3, "Serializing response"],
    };
    let stopHeartbeat: (() => Promise<void>) | undefined;

    const result = await runGetFigmaData(figmaService, { fileKey, nodeId, depth }, outputFormat, {
      onPhaseStart: async (phase, progress) => {
        const step = steps[phase];
        if (!step) return;
        const [index, message] = step;
        await sendProgress(extra, index, 4, message);
        if (phase === "serialize") return;
        stopHeartbeat = startProgressHeartbeat(extra, () =>
          phase === "simplify"
            ? `Simplifying design data (${progress.getNodeCount()} nodes processed)`
            : message,
        );
      },
      onPhaseEnd: async () => {
        await stopHeartbeat?.();
        stopHeartbeat = undefined;
      },
      onComplete,
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
