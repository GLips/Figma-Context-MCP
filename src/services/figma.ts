import type {
  GetImagesResponse,
  GetFileResponse,
  GetFileNodesResponse,
  GetImageFillsResponse,
} from "@figma/rest-api-spec";
import { downloadFigmaImage } from "~/utils/common.js";
import { downloadAndProcessImage, type ImageProcessingResult } from "~/utils/image-processing.js";
import { Logger, writeLogs } from "~/utils/logger.js";
import { fetchWithRetry } from "~/utils/fetch-with-retry.js";

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

  constructor({ figmaApiKey, figmaOAuthToken, useOAuth }: FigmaAuthOptions) {
    this.apiKey = figmaApiKey || "";
    this.oauthToken = figmaOAuthToken || "";
    this.useOAuth = !!useOAuth && !!this.oauthToken;
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

      return await fetchWithRetry<T>(`${this.baseUrl}${endpoint}`, { headers });
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
      cropTransform?: any;
      requiresImageDimensions?: boolean;
    }>,
    options: { pngScale?: number; svgOptions?: SvgOptions } = {},
  ): Promise<ImageProcessingResult[]> {
    if (items.length === 0) return [];

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
                localPath,
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
                  localPath,
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
                  localPath,
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
    const endpoint = `/files/${fileKey}${depth ? `?depth=${depth}` : ""}`;
    Logger.log(`Retrieving raw Figma file: ${fileKey} (depth: ${depth ?? "default"})`);

    const response = await this.request<GetFileResponse>(endpoint);
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
    const endpoint = `/files/${fileKey}/nodes?ids=${nodeId}${depth ? `&depth=${depth}` : ""}`;
    Logger.log(
      `Retrieving raw Figma node: ${nodeId} from ${fileKey} (depth: ${depth ?? "default"})`,
    );

    const response = await this.request<GetFileNodesResponse>(endpoint);
    writeLogs("figma-raw.json", response);

    return response;
  }
}
