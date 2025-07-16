import fs from "fs";
import {
  parseFigmaResponse,
  type SimplifiedDesign,
  type SimplifiedNode,
} from "./simplify-node-response.js";
import type {
  GetImagesResponse,
  GetFileResponse,
  GetFileNodesResponse,
  GetImageFillsResponse,
  GetFileMetaResponse,
} from "@figma/rest-api-spec";
import { downloadFigmaImage, normalizeFigmaNodeId } from "~/utils/common.js";
import { Logger } from "~/utils/logger.js";
import { fetchWithRetry } from "~/utils/fetch-with-retry.js";
import { ParseDataCache } from "~/utils/parse-data-cache.js";
import { writeJSON2YamlLogs, writeLogs } from "../utils/write-log.js";

export type FigmaAuthOptions = {
  figmaApiKey: string;
  figmaOAuthToken: string;
  useOAuth: boolean;
  useCache: boolean;
};

type FetchImageParams = {
  /**
   * The Node in Figma that will either be rendered or have its background image downloaded
   */
  nodeId: string;
  /**
   * The local file name to save the image
   */
  fileName: string;
  /**
   * The file mimetype for the image
   */
  fileType: "png" | "svg";
};

type FetchImageFillParams = Omit<FetchImageParams, "fileType"> & {
  /**
   * Required to grab the background image when an image is used as a fill
   */
  imageRef: string;
};

export class FigmaService {
  private readonly apiKey: string;
  private readonly oauthToken: string;
  private readonly useOAuth: boolean;
  private readonly baseUrl = "https://api.figma.com/v1";
  private readonly cache: ParseDataCache;
  private readonly useCache: boolean;

  constructor({ figmaApiKey, figmaOAuthToken, useOAuth, useCache }: FigmaAuthOptions) {
    this.apiKey = figmaApiKey || "";
    this.oauthToken = figmaOAuthToken || "";
    this.useOAuth = !!useOAuth && !!this.oauthToken;
    // Create cache with capacity for 10 file node data entries
    this.cache = new ParseDataCache(10);
    this.useCache = useCache;
  }

  private async request<T>(endpoint: string): Promise<T> {
    try {
      Logger.log(`Calling ${this.baseUrl}${endpoint}`);

      // Set auth headers based on authentication method
      const headers: Record<string, string> = {};

      if (this.useOAuth) {
        // Use OAuth token with Authorization: Bearer header
        Logger.log("Using OAuth Bearer token for authentication");
        headers["Authorization"] = `Bearer ${this.oauthToken}`;
      } else {
        // Use Personal Access Token with X-Figma-Token header
        Logger.log("Using Personal Access Token for authentication");
        headers["X-Figma-Token"] = this.apiKey;
      }

      return await fetchWithRetry<T>(`${this.baseUrl}${endpoint}`, {
        headers,
      });
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to make request to Figma API: ${error.message}`);
      }
      throw new Error(`Failed to make request to Figma API: ${error}`);
    }
  }

  async getImageFills(
    fileKey: string,
    nodes: FetchImageFillParams[],
    localPath: string,
  ): Promise<string[]> {
    if (nodes.length === 0) return [];

    let promises: Promise<string>[] = [];
    const endpoint = `/files/${fileKey}/images`;
    const file = await this.request<GetImageFillsResponse>(endpoint);
    const { images = {} } = file.meta;
    promises = nodes.map(async ({ imageRef, fileName }) => {
      const imageUrl = images[imageRef];
      if (!imageUrl) {
        return "";
      }
      return downloadFigmaImage(fileName, localPath, imageUrl);
    });
    return Promise.all(promises);
  }

  async getImages(
    fileKey: string,
    nodes: FetchImageParams[],
    localPath: string,
    pngScale: number,
    svgOptions: {
      outlineText: boolean;
      includeId: boolean;
      simplifyStroke: boolean;
    },
  ): Promise<string[]> {
    const pngIds = nodes.filter(({ fileType }) => fileType === "png").map(({ nodeId }) => nodeId);
    const pngFiles =
      pngIds.length > 0
        ? this.request<GetImagesResponse>(
            `/images/${fileKey}?ids=${pngIds.join(",")}&format=png&scale=${pngScale}`,
          ).then(({ images = {} }) => images)
        : ({} as GetImagesResponse["images"]);

    const svgIds = nodes.filter(({ fileType }) => fileType === "svg").map(({ nodeId }) => nodeId);
    const svgParams = [
      `ids=${svgIds.join(",")}`,
      "format=svg",
      `svg_outline_text=${svgOptions.outlineText}`,
      `svg_include_id=${svgOptions.includeId}`,
      `svg_simplify_stroke=${svgOptions.simplifyStroke}`,
    ].join("&");

    const svgFiles =
      svgIds.length > 0
        ? this.request<GetImagesResponse>(`/images/${fileKey}?${svgParams}`).then(
            ({ images = {} }) => images,
          )
        : ({} as GetImagesResponse["images"]);

    const files = await Promise.all([pngFiles, svgFiles]).then(([f, l]) => ({ ...f, ...l }));

    const downloads = nodes
      .map(({ nodeId, fileName }) => {
        const imageUrl = files[nodeId];
        if (imageUrl) {
          return downloadFigmaImage(fileName, localPath, imageUrl);
        }
        return false;
      })
      .filter((url) => !!url);

    return Promise.all(downloads);
  }

  async getFile(fileKey: string, depth?: number | null): Promise<SimplifiedDesign> {
    try {
      const endpoint = `/files/${fileKey}${depth ? `?depth=${depth}` : ""}`;
      Logger.log(`Retrieving Figma file: ${fileKey} (depth: ${depth ?? "default"})`);
      const response = await this.request<GetFileResponse>(endpoint);
      Logger.log("Got response");
      const simplifiedResponse = parseFigmaResponse(response);
      writeJSON2YamlLogs("figma-raw.yml", response);
      writeJSON2YamlLogs("figma-simplified.yml", simplifiedResponse);
      return simplifiedResponse;
    } catch (e) {
      console.error("Failed to get file:", e);
      throw e;
    }
  }

  async getFileMeta(fileKey: string): Promise<GetFileMetaResponse> {
    const endpoint = `/files/${fileKey}/meta`;
    const response = await this.request<GetFileMetaResponse>(endpoint);
    return response;
  }

  /**
   * normal nodes handle
   * @param fileKey Figma file ID
   * @param nodeIds node ID string (comma separated)
   * @param depth depth parameter
   * @returns processed simplified design data
   */
  private async fetchAndProcessNodes(
    fileKey: string,
    nodeIds: string,
    depth?: number | null,
  ): Promise<SimplifiedDesign> {
    const endpoint = `/files/${fileKey}/nodes?ids=${nodeIds}${depth ? `&depth=${depth}` : ""}`;
    const response = await this.request<GetFileNodesResponse>(endpoint);
    Logger.log("Got response from getNode, now parsing.");
    const apiResponse = parseFigmaResponse(response);

    writeJSON2YamlLogs("figma-raw.yml", response);
    writeJSON2YamlLogs("figma-simplified.yml", apiResponse);
    writeLogs("figma-raw.json", JSON.stringify(response));
    writeLogs("figma-simplified.json", JSON.stringify(apiResponse));

    return apiResponse;
  }

  async getNode(
    fileKey: string,
    _nodeIds: string,
    depth?: number | null,
  ): Promise<SimplifiedDesign> {
    const startTime = performance.now();
    const nodeIds = normalizeFigmaNodeId(_nodeIds);

    let result: SimplifiedDesign;
    if (!this.useCache) {
      Logger.log(`Cache disabled, making direct API call for nodes: ${nodeIds}`);
      result = await this.fetchAndProcessNodes(fileKey, nodeIds, depth);
    } else {
      const cacheKey = `${fileKey}:${nodeIds}:${depth || "default"}`;

      // Create validation params for cache freshness validation
      const validationParams = {
        fileKey,
        getFileMeta: () => this.getFileMeta(fileKey),
      };

      // First check for exact cache match
      const cachedResult = await this.cache.get(cacheKey, validationParams);
      if (cachedResult) {
        Logger.log(`Cache hit: ${cacheKey}`);
        result = cachedResult;
      } else {
        // Parse requested node IDs array
        const nodeIdArray = nodeIds.split(",").map((id) => id.trim());

        // Check cache status for multiple nodes with depth consideration
        const { cachedNodes, missingNodeIds, sourceDesign } = await this.cache.findMultipleNodes(
          fileKey,
          nodeIdArray,
          validationParams,
          depth,
        );

        // If all nodes are cached, return merged result directly
        if (missingNodeIds.length === 0 && sourceDesign) {
          Logger.log(`All nodes are cached: ${nodeIds}`);
          const mergedDesign = this.cache.mergeNodesAsDesign(sourceDesign, cachedNodes);
          // Cache merged result
          this.cache.put(cacheKey, mergedDesign, sourceDesign.lastModified);
          result = mergedDesign;
        } else {
          // If some nodes are missing, request only the missing nodes
          let apiResponse: SimplifiedDesign | null = null;
          if (missingNodeIds.length > 0) {
            const missingNodeIdsStr = missingNodeIds.join(",");
            Logger.log(`Partial cache miss, requesting missing nodes: ${missingNodeIdsStr}`);
            apiResponse = await this.fetchAndProcessNodes(fileKey, missingNodeIdsStr, depth);
          }

          // Merge cached nodes and API response nodes
          const allNodes: SimplifiedNode[] = [...cachedNodes];
          if (apiResponse) {
            allNodes.push(...apiResponse.nodes);
          }

          // Create final merged result
          const finalDesign = this.cache.mergeNodesAsDesign(sourceDesign || apiResponse!, allNodes);

          this.cache.put(cacheKey, finalDesign, finalDesign.lastModified);

          Logger.log(
            `Cached merged result: ${cacheKey} (cached nodes: ${cachedNodes.length}, API nodes: ${apiResponse?.nodes.length || 0})`,
          );

          result = finalDesign;
        }
      }
    }
    const endTime = performance.now();
    Logger.log(`Figma Call Node Time taken: ${((endTime - startTime) / 1000).toFixed(2)} seconds`);
    return result;
  }

  /**
   * Clear all cache entries for a specific file
   */
  clearFileCache(fileKey: string): void {
    this.cache.clearFileCache(fileKey);
  }

  /**
   * Clear all cache entries
   */
  clearAllCache(): void {
    this.cache.clearAllCache();
  }
}
