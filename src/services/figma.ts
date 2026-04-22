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
import { fetchJSON } from "~/utils/fetch-json.js";
import { getErrorMeta } from "~/utils/error-meta.js";
import { buildForbiddenMessage, buildRateLimitMessage } from "./errors/index.js";
import { FigmaFileCache, type FigmaCachingOptions } from "./figma-file-cache.js";

export type FigmaAuthOptions = {
  figmaApiKey: string;
  figmaOAuthToken: string;
  useOAuth: boolean;
};

export type CacheInfo = {
  usedCache: boolean;
  cachedAt?: number;
  ttlMs?: number;
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
    const { data } = await this.requestWithSize<T>(endpoint);
    return data;
  }

  private async requestWithSize<T>(endpoint: string): Promise<{ data: T; rawSize: number }> {
    try {
      Logger.log(`Calling ${this.baseUrl}${endpoint}`);
      const headers = this.getAuthHeaders();

      return await fetchJSON<T & { status?: number }>(`${this.baseUrl}${endpoint}`, {
        headers,
        redactFromResponseBody: [this.apiKey, this.oauthToken],
      });
    } catch (error) {
      const meta = getErrorMeta(error);
      if (meta.http_status === 429) {
        throw new Error(buildRateLimitMessage(error), { cause: error });
      }
      if (meta.http_status === 403) {
        throw new Error(buildForbiddenMessage(endpoint, error), { cause: error });
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to make request to Figma API endpoint '${endpoint}': ${errorMessage}`,
        { cause: error },
      );
    }
  }

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

  async getImageFillUrls(fileKey: string): Promise<Record<string, string>> {
    const endpoint = `/files/${fileKey}/images`;
    const response = await this.request<GetImageFillsResponse>(endpoint);
    return response.meta.images || {};
  }

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

  async downloadImages(
    fileKey: string,
    localPath: string,
    items: Array<{
      imageRef?: string;
      gifRef?: string;
      nodeId?: string;
      fileName: string;
      needsCropping?: boolean;
      cropTransform?: Transform;
      requiresImageDimensions?: boolean;
    }>,
    options: { pngScale?: number; svgOptions?: SvgOptions } = {},
  ): Promise<ImageProcessingResult[]> {
    if (items.length === 0) return [];

    const resolvedPath = localPath;
    const { pngScale = 2, svgOptions } = options;
    const downloadPromises: Promise<ImageProcessingResult[]>[] = [];

    const imageFills = items.filter(
      (item): item is typeof item & ({ imageRef: string } | { gifRef: string }) =>
        !!item.imageRef || !!item.gifRef,
    );
    const renderNodes = items.filter(
      (item): item is typeof item & { nodeId: string } => !!item.nodeId,
    );

    if (imageFills.length > 0) {
      const fillUrls = await this.getImageFillUrls(fileKey);
      const fillDownloads = imageFills
        .map(
          ({
            imageRef,
            gifRef,
            fileName,
            needsCropping,
            cropTransform,
            requiresImageDimensions,
          }) => {
            const fillRef = gifRef ?? imageRef;
            const imageUrl = fillRef ? fillUrls[fillRef] : undefined;
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
          },
        )
        .filter((promise): promise is Promise<ImageProcessingResult> => promise !== null);

      if (fillDownloads.length > 0) {
        downloadPromises.push(Promise.all(fillDownloads));
      }
    }

    if (renderNodes.length > 0) {
      const pngNodes = renderNodes.filter((node) => !node.fileName.toLowerCase().endsWith(".svg"));
      const svgNodes = renderNodes.filter((node) => node.fileName.toLowerCase().endsWith(".svg"));

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

  async getRawFile(
    fileKey: string,
    depth?: number | null,
  ): Promise<{ data: GetFileResponse; rawSize: number; cacheInfo: CacheInfo }> {
    if (this.fileCache) {
      const cacheResult = await this.loadFileFromCache(fileKey);
      if (typeof depth === "number") {
        const truncated = cloneFileResponseWithDepth(cacheResult.data, depth);
        writeLogs("figma-raw.json", truncated);
        return {
          data: truncated,
          rawSize: measureRawSize(truncated),
          cacheInfo: cacheResult.cacheInfo,
        };
      }

      writeLogs("figma-raw.json", cacheResult.data);
      return cacheResult;
    }

    const result = await this.fetchFileFromApi(fileKey, depth);
    writeLogs("figma-raw.json", result.data);
    return { ...result, cacheInfo: { usedCache: false } };
  }

  async getRawNode(
    fileKey: string,
    nodeId: string,
    depth?: number | null,
  ): Promise<{ data: GetFileNodesResponse; rawSize: number; cacheInfo: CacheInfo }> {
    if (this.fileCache) {
      const cacheResult = await this.loadFileFromCache(fileKey);
      const nodeResponse = buildNodeResponseFromFile(cacheResult.data, nodeId, depth);
      writeLogs("figma-raw.json", nodeResponse);
      return {
        data: nodeResponse,
        rawSize: measureRawSize(nodeResponse),
        cacheInfo: cacheResult.cacheInfo,
      };
    }

    const endpoint = `/files/${fileKey}/nodes?ids=${nodeId}${depth ? `&depth=${depth}` : ""}`;
    Logger.log(
      `Retrieving raw Figma node: ${nodeId} from ${fileKey} (depth: ${depth ?? "default"})`,
    );

    const result = await this.requestWithSize<GetFileNodesResponse>(endpoint);
    writeLogs("figma-raw.json", result.data);

    return { ...result, cacheInfo: { usedCache: false } };
  }

  private async loadFileFromCache(
    fileKey: string,
  ): Promise<{ data: GetFileResponse; rawSize: number; cacheInfo: CacheInfo }> {
    const cacheResult = await this.fileCache?.get(fileKey);
    if (cacheResult) {
      return {
        data: cacheResult.data,
        rawSize: measureRawSize(cacheResult.data),
        cacheInfo: {
          usedCache: true,
          cachedAt: cacheResult.cachedAt,
          ttlMs: cacheResult.ttlMs,
        },
      };
    }

    const fresh = await this.fetchFileFromApi(fileKey);
    await this.fileCache?.set(fileKey, fresh.data);
    return { ...fresh, cacheInfo: { usedCache: false } };
  }

  private async fetchFileFromApi(
    fileKey: string,
    depth?: number | null,
  ): Promise<{ data: GetFileResponse; rawSize: number }> {
    const endpoint = `/files/${fileKey}${depth ? `?depth=${depth}` : ""}`;
    Logger.log(`Retrieving raw Figma file: ${fileKey} (depth: ${depth ?? "default"})`);
    return this.requestWithSize<GetFileResponse>(endpoint);
  }
}

function cloneFileResponseWithDepth(file: GetFileResponse, depth: number): GetFileResponse {
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

function measureRawSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

type NodeWithChildren = FigmaNode & { children: FigmaNode[] };

function nodeHasChildren(node: FigmaNode): node is NodeWithChildren {
  const maybeChildren = (node as Partial<NodeWithChildren>).children;
  return Array.isArray(maybeChildren) && maybeChildren.length > 0;
}
