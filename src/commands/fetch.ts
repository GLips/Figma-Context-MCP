import { command } from "cleye";
import { parseOutputFormat, requireGlobalCredential, UsageError } from "~/config.js";
import { getFigmaDataTool } from "~/mcp/tools/get-figma-data-tool.js";
import { FigmaService, staticCredentialSource } from "~/services/figma.js";
import { captureReadToolCall } from "~/telemetry/index.js";
import { getFigmaData } from "~/services/get-figma-data.js";
import type { OutputFormat } from "~/utils/serialize.js";
import { buildCommandHelp } from "~/utils/cli-help.js";
import { figmaFileKey, figmaNodeId } from "~/utils/figma-url.js";
import { defineCliCommand } from "./cli-command.js";
import { printCliFailure, type CliCommandContext } from "./cli-context.js";
import { REST_COMMAND_FLAGS, resolveRestTarget } from "./rest-command.js";

export const fetchCommand = defineCliCommand(
  command({
    name: "fetch",
    parameters: ["[url]"],
    help: buildCommandHelp({
      name: "fetch",
      summary: "Print a Figma file or node as simplified design data, like get_figma_data",
      details:
        "Reads over the Figma REST API, so it needs a token (--figma-api-key or FIGMA_API_KEY).\nA URL's node-id selects the node; without one you get the whole file, which can be large.",
      exampleArgs: [
        `"https://www.figma.com/design/<fileKey>/Name?node-id=12-34"`,
        "--file-key <fileKey> --node-id 12:34 --format json > node.json",
      ],
    }),
    flags: {
      ...REST_COMMAND_FLAGS,
      nodeId: {
        type: String,
        placeholder: "<id>",
        description: "Node ID like 1234:5678; overrides the URL's",
      },
      depth: {
        type: Number,
        placeholder: "<n>",
        description: "Limit output to this many levels of children",
      },
      json: {
        type: Boolean,
        description: "Alias for --format json",
      },
      format: {
        type: String,
        placeholder: "<yaml|json|tree>",
        description: "Output format (default yaml; tree is the compact one the MCP server uses)",
      },
    },
  }),
  (argv, context) => runFetch(argv.flags, argv._, context),
);

export async function runFetch(
  flags: {
    fileKey?: string;
    nodeId?: string;
    depth?: number;
    json?: boolean;
    format?: string;
  },
  positionals: string[],
  context: CliCommandContext,
): Promise<number> {
  const target = resolveRestTarget(positionals[0], flags);
  // The tool's own validation, so the CLI accepts exactly what get_figma_data does.
  const parsed = getFigmaDataTool.parametersSchema.safeParse({ ...target, depth: flags.depth });
  if (!parsed.success) {
    throw new UsageError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"),
    );
  }
  const fileKey = figmaFileKey(parsed.data.fileKey);
  const nodeId = parsed.data.nodeId === undefined ? undefined : figmaNodeId(parsed.data.nodeId);
  const depth = parsed.data.depth;
  const credential = requireGlobalCredential(context.credential);
  // The fetch CLI stays yaml-by-default (unlike the MCP server, which defaults
  // to tree): its output is piped into standard tooling (`> out.yaml`, `| jq`),
  // where tree's bespoke indented format isn't parseable. Tree's token-efficiency
  // win is for LLM consumers, not shell pipelines.
  const outputFormat: OutputFormat =
    parseOutputFormat(flags.format, "--format") ?? (flags.json ? "json" : "yaml");

  return context.observe("get_figma_data", captureReadToolCall, async (call) => {
    try {
      const result = await getFigmaData(
        new FigmaService(staticCredentialSource(credential)).withSignal(context.signal),
        { fileKey, nodeId, depth },
        outputFormat,
        { onComplete: call.record },
      );
      console.log(result.formatted);
      return 0;
    } catch (error) {
      return printCliFailure(error);
    }
  });
}
