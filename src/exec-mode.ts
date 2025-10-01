import { FigmaService } from "./services/figma.js";
import { simplifyRawFigmaObject, allExtractors } from "./extractors/index.js";
import { parseFigmaUrl } from "./utils/url-parser.js";
import type { FigmaAuthOptions } from "./services/figma.js";
import yaml from "js-yaml";

/**
 * Execute a single Figma data fetch and output to stdout, then exit.
 * This is a non-server mode for one-off data retrieval.
 */
export async function executeOnce(
  figmaUrl: string,
  authOptions: FigmaAuthOptions,
  outputFormat: "yaml" | "json",
): Promise<void> {
  const { fileKey, nodeId: rawNodeId } = parseFigmaUrl(figmaUrl);

  // Replace - with : in nodeId for API query Figma API expects
  const nodeId = rawNodeId?.replace(/-/g, ":");

  const figmaService = new FigmaService(authOptions);

  const rawApiResponse = nodeId
    ? await figmaService.getRawNode(fileKey, nodeId, null)
    : await figmaService.getRawFile(fileKey, null);

  const simplifiedDesign = simplifyRawFigmaObject(rawApiResponse, allExtractors);

  const { nodes, globalVars, ...metadata } = simplifiedDesign;
  const result = {
    metadata,
    nodes,
    globalVars,
  };

  const formattedResult =
    outputFormat === "json" ? JSON.stringify(result, null, 2) : yaml.dump(result);

  console.log(formattedResult);
}
