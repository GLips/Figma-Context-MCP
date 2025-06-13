import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FigmaService, type FigmaAuthOptions } from "./services/figma.js";
import type { SimplifiedDesign } from "./services/simplify-node-response.js";
import yaml from "js-yaml";
import { Logger } from "./utils/logger.js";
import { convertPngToWebp } from "./utils/imageConverter.js";

const serverInfo = {
  name: "Figma MCP Server",
  version: process.env.NPM_PACKAGE_VERSION ?? "unknown",
};

type CreateServerOptions = {
  isHTTP?: boolean;
  outputFormat?: "yaml" | "json";
  webp?: {
    enabled: boolean;
    quality: number;
    keepOriginal: boolean;
  };
};

function createServer(
  authOptions: FigmaAuthOptions,
  { isHTTP = false, outputFormat = "yaml", webp = { enabled: false, quality: 80, keepOriginal: false } }: CreateServerOptions = {},
) {
  const server = new McpServer(serverInfo);
  // const figmaService = new FigmaService(figmaApiKey);
  const figmaService = new FigmaService(authOptions);
  registerTools(server, figmaService, outputFormat, webp);

  Logger.isHTTP = isHTTP;

  return server;
}

function registerTools(
  server: McpServer,
  figmaService: FigmaService,
  outputFormat: "yaml" | "json",
  webp: { enabled: boolean; quality: number; keepOriginal: boolean },
): void {
  // Tool to get file information
  server.tool(
    "get_figma_data",
    "When the nodeId cannot be obtained, obtain the layout information about the entire Figma file",
    {
      fileKey: z
        .string()
        .describe(
          "The key of the Figma file to fetch, often found in a provided URL like figma.com/(file|design)/<fileKey>/...",
        ),
      nodeId: z
        .string()
        .optional()
        .describe(
          "The ID of the node to fetch, often found as URL parameter node-id=<nodeId>, always use if provided",
        ),
      depth: z
        .number()
        .optional()
        .describe(
          "OPTIONAL. Do NOT use unless explicitly requested by the user. Controls how many levels deep to traverse the node tree,",
        ),
    },
    async ({ fileKey, nodeId, depth }) => {
      try {
        Logger.log(
          `Fetching ${
            depth ? `${depth} layers deep` : "all layers"
          } of ${nodeId ? `node ${nodeId} from file` : `full file`} ${fileKey}`,
        );

        let file: SimplifiedDesign;
        if (nodeId) {
          file = await figmaService.getNode(fileKey, nodeId, depth);
        } else {
          file = await figmaService.getFile(fileKey, depth);
        }

        Logger.log(`Successfully fetched file: ${file.name}`);
        const { nodes, globalVars, ...metadata } = file;

        const result = {
          metadata,
          nodes,
          globalVars,
        };

        Logger.log(`Generating ${outputFormat.toUpperCase()} result from file`);
        const formattedResult =
          outputFormat === "json" ? JSON.stringify(result, null, 2) : yaml.dump(result);

        Logger.log("Sending result to client");
        return {
          content: [{ type: "text", text: formattedResult }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        Logger.error(`Error fetching file ${fileKey}:`, message);
        return {
          isError: true,
          content: [{ type: "text", text: `Error fetching file: ${message}` }],
        };
      }
    },
  );

  // TODO: Clean up all image download related code, particularly getImages in Figma service
  // Tool to download images
  server.tool(
    "download_figma_images",
    "Download SVG and PNG images used in a Figma file based on the IDs of image or icon nodes",
    {
      fileKey: z.string().describe("The key of the Figma file containing the node"),
      nodes: z
        .object({
          nodeId: z
            .string()
            .describe("The ID of the Figma image node to fetch, formatted as 1234:5678"),
          imageRef: z
            .string()
            .optional()
            .describe(
              "If a node has an imageRef fill, you must include this variable. Leave blank when downloading Vector SVG images.",
            ),
          fileName: z.string().describe("The local name for saving the fetched file"),
        })
        .array()
        .describe("The nodes to fetch as images"),
      pngScale: z
        .number()
        .positive()
        .optional()
        .default(2)
        .describe(
          "Export scale for PNG images. Optional, defaults to 2 if not specified. Affects PNG images only.",
        ),
      localPath: z
        .string()
        .describe(
          "The absolute path to the directory where images are stored in the project. If the directory does not exist, it will be created. The format of this path should respect the directory format of the operating system you are running on. Don't use any special character escaping in the path name either.",
        ),
      svgOptions: z
        .object({
          outlineText: z
            .boolean()
            .optional()
            .default(true)
            .describe("Whether to outline text in SVG exports. Default is true."),
          includeId: z
            .boolean()
            .optional()
            .default(false)
            .describe("Whether to include IDs in SVG exports. Default is false."),
          simplifyStroke: z
            .boolean()
            .optional()
            .default(true)
            .describe("Whether to simplify strokes in SVG exports. Default is true."),
        })
        .optional()
        .default({})
        .describe("Options for SVG export"),
      convertToWebp: z
        .boolean()
        .optional()
        .describe("Whether to convert PNG images to WebP format. If not specified, uses the server's default configuration."),
    },
    async ({ fileKey, nodes, localPath, svgOptions, pngScale, convertToWebp }) => {
      try {
        // 确定是否需要转换为WebP
        // Determine if WebP conversion is needed
        const shouldConvertToWebp = convertToWebp !== undefined ? convertToWebp : webp.enabled;
        
        const imageFills = nodes.filter(({ imageRef }) => !!imageRef) as {
          nodeId: string;
          imageRef: string;
          fileName: string;
        }[];
        const fillDownloads = figmaService.getImageFills(fileKey, imageFills, localPath);
        const renderRequests = nodes
          .filter(({ imageRef }) => !imageRef)
          .map(({ nodeId, fileName }) => ({
            nodeId,
            fileName,
            fileType: fileName.endsWith(".svg") ? ("svg" as const) : ("png" as const),
          }));

        const renderDownloads = figmaService.getImages(
          fileKey,
          renderRequests,
          localPath,
          pngScale,
          svgOptions,
        );

        const downloads = await Promise.all([fillDownloads, renderDownloads]).then(([f, r]) => [
          ...f,
          ...r,
        ]);

        // If any download fails, return false
        const saveSuccess = !downloads.find((success) => !success);
        
        // 如果启用了WebP转换，并且下载成功，则转换PNG为WebP
        // If WebP conversion is enabled and download was successful, convert PNG to WebP
        let webpResult = "";
        if (saveSuccess && shouldConvertToWebp) {
          try {
            // 筛选出PNG图片
            // Filter PNG images
            const pngFiles = downloads.filter(path => 
              typeof path === 'string' && path.toLowerCase().endsWith('.png')
            ) as string[];
            
            if (pngFiles.length > 0) {
              Logger.log(`Converting ${pngFiles.length} PNG images to WebP format`);
              
              // 转换为WebP
              // Convert to WebP
              const stats = await convertPngToWebp(pngFiles, {
                quality: webp.quality,
                keepOriginal: webp.keepOriginal,
                verbose: true
              });
              
              const savedSize = stats.totalSizeBefore - stats.totalSizeAfter;
              const compressionRatio = stats.totalSizeBefore > 0
                ? (savedSize / stats.totalSizeBefore * 100).toFixed(2)
                : '0';
                
              webpResult = ` Additionally, ${stats.convertedFiles}/${pngFiles.length} PNG images were converted to WebP format, saving ${compressionRatio}% space.`;
            }
          } catch (error) {
            Logger.error("WebP conversion failed:", error);
            webpResult = " WebP conversion was attempted but failed.";
          }
        }
        
        return {
          content: [
            {
              type: "text",
              text: saveSuccess
                ? `Success, ${downloads.length} images downloaded: ${downloads.join(", ")}${webpResult}`
                : "Failed",
            },
          ],
        };
      } catch (error) {
        Logger.error(`Error downloading images from file ${fileKey}:`, error);
        return {
          isError: true,
          content: [{ type: "text", text: `Error downloading images: ${error}` }],
        };
      }
    },
  );

  // Tool to convert PNG images to WebP format
  server.tool(
    "convert_png_to_webp",
    "Convert downloaded PNG images to WebP format with compression",
    {
      imagePaths: z
        .string()
        .array()
        .describe("Array of paths to the PNG images that need to be converted to WebP"),
      quality: z
        .number()
        .positive()
        .max(100)
        .optional()
        .default(80)
        .describe("WebP compression quality (1-100). Higher values mean better quality but larger file size. Default is 80."),
      keepOriginal: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to keep the original PNG images after conversion. Default is false (will delete original PNGs)."),
      verbose: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to output detailed logs during conversion. Default is false."),
    },
    async ({ imagePaths, quality, keepOriginal, verbose }) => {
      try {
        Logger.log(`Converting ${imagePaths.length} PNG images to WebP format (quality: ${quality}, keepOriginal: ${keepOriginal})`);
        
        const stats = await convertPngToWebp(imagePaths, {
          quality,
          keepOriginal,
          verbose
        });

        const savedSize = stats.totalSizeBefore - stats.totalSizeAfter;
        const compressionRatio = stats.totalSizeBefore > 0
          ? (savedSize / stats.totalSizeBefore * 100).toFixed(2)
          : '0';

        return {
          content: [
            {
              type: "text",
              text: `Conversion completed: ${stats.convertedFiles}/${stats.totalFiles} images converted to WebP. ${stats.skippedFiles} skipped, ${stats.errorFiles} errors. Space saved: ${compressionRatio}%`
            },
          ],
        };
      } catch (error) {
        Logger.error(`Error converting PNG images to WebP:`, error);
        return {
          isError: true,
          content: [{ type: "text", text: `Error converting images: ${error}` }],
        };
      }
    },
  );
}

export { createServer };
