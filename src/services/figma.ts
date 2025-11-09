import path from "path";
import type {
  GetImagesResponse,
  GetFileResponse,
  GetFileNodesResponse,
  GetImageFillsResponse,
  Node as FigmaNode,
  DocumentNode,
  Transform,
} from "@figma/rest-api-spec";
import { downloadAndProcessImage, type ImageProcessingResult } from "~/utils/image-processing.js";
import { Logger, writeLogs } from "~/utils/logger.js";
import { fetchWithRetry } from "~/utils/fetch-with-retry.js";
import { FigmaFileCache, type FigmaCachingOptions } from "./figma-file-cache.js";

export type FigmaAuthOptions = {
  figmaApiKey: string;
  figmaOAuthToken: string;
  useOAuth: boolean;
};

type SvgOptions = {
  outlineText: boolean;
  includeId: boolean;
  simplifyStroke: boolean;
};

export class FigmaService {
  private readonly apiKey: string;
  private readonly oauthToken: string;
  private readonly useOAuth: boolean;
  private readonly baseUrl = "https://api.figma.com/v1";
  private readonly fileCache?: FigmaFileCache;

  constructor(
    { figmaApiKey, figmaOAuthToken, useOAuth }: FigmaAuthOptions,
    cachingOptions?: FigmaCachingOptions,
  ) {
    this.apiKey = figmaApiKey || "";
    this.oauthToken = figmaOAuthToken || "";
    this.useOAuth = !!useOAuth && !!this.oauthToken;
    if (cachingOptions) {
      this.fileCache = new FigmaFileCache(cachingOptions);
    }
  }

  private getAuthHeaders(): Record<string, string> {
    if (this.useOAuth) {
      Logger.log("Using OAuth Bearer token for authentication");
      return { Authorization: `Bearer ${this.oauthToken}` };
    } else {
      Logger.log("Using Personal Access Token for authentication");
      return { "X-Figma-Token": this.apiKey };
    }
  }

  /**
   * Filters out null values from Figma image responses. This ensures we only work with valid image URLs.
   */
  private filterValidImages(
    images: { [key: string]: string | null } | undefined,
  ): Record<string, string> {
    if (!images) return {};
    return Object.fromEntries(Object.entries(images).filter(([, value]) => !!value)) as Record<
      string,
      string
    >;
  }

  private async request<T>(endpoint: string): Promise<T> {
    try {
      Logger.log(`Calling ${this.baseUrl}${endpoint}`);
      const headers = this.getAuthHeaders();

      return await fetchWithRetry<T & { status?: number }>(`${this.baseUrl}${endpoint}`, {
        headers,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to make request to Figma API endpoint '${endpoint}': ${errorMessage}`,
      );
    }
  }

  /**
   * Builds URL query parameters for SVG image requests.
   */
  private buildSvgQueryParams(svgIds: string[], svgOptions: SvgOptions): string {
    const params = new URLSearchParams({
      ids: svgIds.join(","),
      format: "svg",
      svg_outline_text: String(svgOptions.outlineText),
      svg_include_id: String(svgOptions.includeId),
      svg_simplify_stroke: String(svgOptions.simplifyStroke),
    });
    return params.toString();
  }

  /**
   * Gets download URLs for image fills without downloading them.
   *
   * @returns Map of imageRef to download URL
   */
  async getImageFillUrls(fileKey: string): Promise<Record<string, string>> {
    const endpoint = `/files/${fileKey}/images`;
    const response = await this.request<GetImageFillsResponse>(endpoint);
    return response.meta.images || {};
  }

  /**
   * Gets download URLs for rendered nodes without downloading them.
   *
   * @returns Map of node ID to download URL
   */
  async getNodeRenderUrls(
    fileKey: string,
    nodeIds: string[],
    format: "png" | "svg",
    options: { pngScale?: number; svgOptions?: SvgOptions } = {},
  ): Promise<Record<string, string>> {
    if (nodeIds.length === 0) return {};

    if (format === "png") {
      const scale = options.pngScale || 2;
      const endpoint = `/images/${fileKey}?ids=${nodeIds.join(",")}&format=png&scale=${scale}`;
      const response = await this.request<GetImagesResponse>(endpoint);
      return this.filterValidImages(response.images);
    } else {
      const svgOptions = options.svgOptions || {
        outlineText: true,
        includeId: false,
        simplifyStroke: true,
      };
      const params = this.buildSvgQueryParams(nodeIds, svgOptions);
      const endpoint = `/images/${fileKey}?${params}`;
      const response = await this.request<GetImagesResponse>(endpoint);
      return this.filterValidImages(response.images);
    }
  }

  /**
   * Download images method with post-processing support for cropping and returning image dimensions.
   *
   * Supports:
   * - Image fills vs rendered nodes (based on imageRef vs nodeId)
   * - PNG vs SVG format (based on filename extension)
   * - Image cropping based on transform matrices
   * - CSS variable generation for image dimensions
   *
   * @returns Array of local file paths for successfully downloaded images
   */
  async downloadImages(
    fileKey: string,
    localPath: string,
    items: Array<{
      imageRef?: string;
      nodeId?: string;
      fileName: string;
      needsCropping?: boolean;
      cropTransform?: Transform;
      requiresImageDimensions?: boolean;
    }>,
    options: { pngScale?: number; svgOptions?: SvgOptions } = {},
  ): Promise<ImageProcessingResult[]> {
    if (items.length === 0) return [];

    const sanitizedPath = path.normalize(localPath).replace(/^(\.\.(\/|\\|$))+/, "");
    const resolvedPath = path.resolve(sanitizedPath);
    if (!resolvedPath.startsWith(path.resolve(process.cwd()))) {
      throw new Error("Invalid path specified. Directory traversal is not allowed.");
    }

    const { pngScale = 2, svgOptions } = options;
    const downloadPromises: Promise<ImageProcessingResult[]>[] = [];

    // Separate items by type
    const imageFills = items.filter(
      (item): item is typeof item & { imageRef: string } => !!item.imageRef,
    );
    const renderNodes = items.filter(
      (item): item is typeof item & { nodeId: string } => !!item.nodeId,
    );

    // Download image fills with processing
    if (imageFills.length > 0) {
      const fillUrls = await this.getImageFillUrls(fileKey);
      const fillDownloads = imageFills
        .map(({ imageRef, fileName, needsCropping, cropTransform, requiresImageDimensions }) => {
          const imageUrl = fillUrls[imageRef];
          return imageUrl
            ? downloadAndProcessImage(
                fileName,
                resolvedPath,
                imageUrl,
                needsCropping,
                cropTransform,
                requiresImageDimensions,
              )
            : null;
        })
        .filter((promise): promise is Promise<ImageProcessingResult> => promise !== null);

      if (fillDownloads.length > 0) {
        downloadPromises.push(Promise.all(fillDownloads));
      }
    }

    // Download rendered nodes with processing
    if (renderNodes.length > 0) {
      const pngNodes = renderNodes.filter((node) => !node.fileName.toLowerCase().endsWith(".svg"));
      const svgNodes = renderNodes.filter((node) => node.fileName.toLowerCase().endsWith(".svg"));

      // Download PNG renders
      if (pngNodes.length > 0) {
        const pngUrls = await this.getNodeRenderUrls(
          fileKey,
          pngNodes.map((n) => n.nodeId),
          "png",
          { pngScale },
        );
        const pngDownloads = pngNodes
          .map(({ nodeId, fileName, needsCropping, cropTransform, requiresImageDimensions }) => {
            const imageUrl = pngUrls[nodeId];
            return imageUrl
              ? downloadAndProcessImage(
                  fileName,
                  resolvedPath,
                  imageUrl,
                  needsCropping,
                  cropTransform,
                  requiresImageDimensions,
                )
              : null;
          })
          .filter((promise): promise is Promise<ImageProcessingResult> => promise !== null);

        if (pngDownloads.length > 0) {
          downloadPromises.push(Promise.all(pngDownloads));
        }
      }

      // Download SVG renders
      if (svgNodes.length > 0) {
        const svgUrls = await this.getNodeRenderUrls(
          fileKey,
          svgNodes.map((n) => n.nodeId),
          "svg",
          { svgOptions },
        );
        const svgDownloads = svgNodes
          .map(({ nodeId, fileName, needsCropping, cropTransform, requiresImageDimensions }) => {
            const imageUrl = svgUrls[nodeId];
            return imageUrl
              ? downloadAndProcessImage(
                  fileName,
                  resolvedPath,
                  imageUrl,
                  needsCropping,
                  cropTransform,
                  requiresImageDimensions,
                )
              : null;
          })
          .filter((promise): promise is Promise<ImageProcessingResult> => promise !== null);

        if (svgDownloads.length > 0) {
          downloadPromises.push(Promise.all(svgDownloads));
        }
      }
    }

    const results = await Promise.all(downloadPromises);
    return results.flat();
  }

  /**
   * Get raw Figma API response for a file (for use with flexible extractors)
   */
  async getRawFile(fileKey: string, depth?: number | null): Promise<GetFileResponse> {
    let response: GetFileResponse;

    if (this.fileCache) {
      response = await this.loadFileFromCache(fileKey);
      if (typeof depth === "number") {
        const truncated = cloneFileResponseWithDepth(response, depth);
        writeLogs("figma-raw.json", truncated);
        return truncated;
      }
      writeLogs("figma-raw.json", response);
      return response;
    }

    response = await this.fetchFileFromApi(fileKey, depth);
    writeLogs("figma-raw.json", response);
    return response;
  }

  /**
   * Get raw Figma API response for specific nodes (for use with flexible extractors)
   */
  async getRawNode(
    fileKey: string,
    nodeId: string,
    depth?: number | null,
  ): Promise<GetFileNodesResponse> {
    if (this.fileCache) {
      const file = await this.loadFileFromCache(fileKey);
      const nodeResponse = buildNodeResponseFromFile(file, nodeId, depth);
      writeLogs("figma-raw.json", nodeResponse);
      return nodeResponse;
    }

    const endpoint = `/files/${fileKey}/nodes?ids=${nodeId}${depth ? `&depth=${depth}` : ""}`;
    Logger.log(
      `Retrieving raw Figma node: ${nodeId} from ${fileKey} (depth: ${depth ?? "default"})`,
    );

    const response = await this.request<GetFileNodesResponse>(endpoint);
    writeLogs("figma-raw.json", response);

    return response;
  }

  private async loadFileFromCache(fileKey: string): Promise<GetFileResponse> {
    if (!this.fileCache) {
      return this.fetchFileFromApi(fileKey);
    }

    const cached = await this.fileCache.get(fileKey);
    if (cached) {
      return cached;
    }

    const fresh = await this.fetchFileFromApi(fileKey);
    await this.fileCache.set(fileKey, fresh);
    return fresh;
  }

  private async fetchFileFromApi(fileKey: string, depth?: number | null): Promise<GetFileResponse> {
    const endpoint = `/files/${fileKey}${depth ? `?depth=${depth}` : ""}`;
    Logger.log(
      `Retrieving raw Figma file: ${fileKey} (depth: ${depth ?? (this.fileCache ? "full" : "default")})`,
    );

    return this.request<GetFileResponse>(endpoint);
  }
}

function cloneFileResponseWithDepth(file: GetFileResponse, depth: number): GetFileResponse {
  if (depth === undefined || depth === null) {
    return file;
  }

  return {
    ...file,
    document: cloneNode(file.document, depth) as DocumentNode,
  };
}

function cloneNode<T extends FigmaNode>(node: T, depth?: number): T {
  const clone = { ...node } as T & { children?: FigmaNode[] };

  if (!nodeHasChildren(node)) {
    delete clone.children;
    return clone;
  }

  if (depth === undefined || depth === null) {
    clone.children = node.children.map((child) => cloneNode(child));
    return clone;
  }

  if (depth <= 0) {
    delete clone.children;
    return clone;
  }

  clone.children = node.children.map((child) => cloneNode(child, depth - 1));

  return clone;
}

function buildNodeResponseFromFile(
  file: GetFileResponse,
  nodeIdParam: string,
  depth?: number | null,
): GetFileNodesResponse {
  const nodeIds = nodeIdParam.split(";").filter((id) => id);
  if (nodeIds.length === 0) {
    throw new Error("No valid node IDs provided");
  }

  const nodesMap = findNodesById(file.document, new Set(nodeIds));
  const nodes: GetFileNodesResponse["nodes"] = {};

  for (const id of nodeIds) {
    const node = nodesMap.get(id);
    if (!node) {
      throw new Error(`Node ${id} not found in cached file`);
    }
    nodes[id] = {
      document: cloneNode(node, depth ?? undefined),
      components: file.components ?? {},
      componentSets: file.componentSets ?? {},
      styles: file.styles,
      schemaVersion: file.schemaVersion,
    };
  }

  return {
    name: file.name,
    lastModified: file.lastModified,
    thumbnailUrl: file.thumbnailUrl ?? "",
    version: file.version ?? "",
    role: file.role ?? "viewer",
    editorType: file.editorType ?? "figma",
    nodes,
  };
}

function findNodesById(root: DocumentNode, targetIds: Set<string>): Map<string, FigmaNode> {
  const result = new Map<string, FigmaNode>();
  const stack: FigmaNode[] = [root];

  while (stack.length > 0 && result.size < targetIds.size) {
    const current = stack.pop();
    if (!current) continue;

    if (targetIds.has(current.id)) {
      result.set(current.id, current);
    }

    if (nodeHasChildren(current)) {
      stack.push(...current.children);
    }
  }

  return result;
}

type NodeWithChildren = FigmaNode & { children: FigmaNode[] };

function nodeHasChildren(node: FigmaNode): node is NodeWithChildren {
  const maybeChildren = (node as Partial<NodeWithChildren>).children;
  return Array.isArray(maybeChildren) && maybeChildren.length > 0;
}
