import { type Command, command } from "cleye";
import { loadEnvFile, resolveAuth } from "~/config.js";
import { FigmaService } from "~/services/figma.js";
import {
  simplifyRawFigmaObject,
  allExtractors,
  collapseSvgContainers,
} from "~/extractors/index.js";
import { serializeResult } from "~/utils/serialize.js";
import { parseFigmaUrl } from "~/utils/figma-url.js";

export const fetchCommand: Command = command(
  {
    name: "fetch",
    description: "Fetch simplified Figma data and print to stdout",
    parameters: ["[url]"],
    flags: {
      fileKey: {
        type: String,
        description: "Figma file key (overrides URL)",
      },
      nodeId: {
        type: String,
        description: "Node ID, format 1234:5678 (overrides URL)",
      },
      depth: {
        type: Number,
        description: "Tree traversal depth",
      },
      json: {
        type: Boolean,
        description: "Output JSON instead of YAML",
      },
      figmaApiKey: {
        type: String,
        description: "Figma API key",
      },
      figmaOauthToken: {
        type: String,
        description: "Figma OAuth token",
      },
      env: {
        type: String,
        description: "Path to .env file",
      },
    },
  },
  (argv) => {
    run(argv.flags, argv._).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  },
);

async function run(
  flags: {
    fileKey?: string;
    nodeId?: string;
    depth?: number;
    json?: boolean;
    figmaApiKey?: string;
    figmaOauthToken?: string;
    env?: string;
  },
  positionals: string[],
) {
  const url = positionals[0];
  let fileKey = flags.fileKey;
  let nodeId = flags.nodeId;

  if (url) {
    try {
      const parsed = parseFigmaUrl(url);
      fileKey ??= parsed.fileKey;
      nodeId ??= parsed.nodeId;
    } catch (error) {
      if (!fileKey) throw error;
      // fileKey provided via flag — malformed URL is non-fatal
    }
  }

  if (!fileKey) {
    console.error("Either a Figma URL or --file-key is required");
    process.exit(1);
  }

  loadEnvFile(flags.env);
  const auth = resolveAuth(flags);
  const figmaService = new FigmaService(auth);

  const depth = flags.depth;
  const rawApiResponse = nodeId
    ? await figmaService.getRawNode(fileKey, nodeId, depth)
    : await figmaService.getRawFile(fileKey, depth);

  const simplifiedDesign = await simplifyRawFigmaObject(rawApiResponse, allExtractors, {
    maxDepth: depth,
    afterChildren: collapseSvgContainers,
  });

  const { nodes, globalVars, ...metadata } = simplifiedDesign;
  const result = { metadata, nodes, globalVars };

  const outputFormat = flags.json ? "json" : "yaml";
  console.log(serializeResult(result, outputFormat));
}
