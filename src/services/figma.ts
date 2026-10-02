import { createHash } from "node:crypto";
import type {
  GetImagesResponse,
  GetFileResponse,
  GetFileNodesResponse,
  GetImageFillsResponse,
  Transform,
} from "@figma/rest-api-spec";
import { downloadAndProcessImage, type ImageProcessingResult } from "~/utils/image-processing.js";
import { Logger, writeLogs } from "~/utils/logger.js";
import { fetchJSON } from "~/utils/fetch-json.js";
import { getErrorMeta } from "~/utils/error-meta.js";
import { buildForbiddenMessage, buildRateLimitMessage } from "./errors/index.js";
import type { ImageUrlCache } from "./response-cache.js";

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

const DEFAULT_SVG_OPTIONS: SvgOptions = {
  outlineText: true,
  includeId: false,
  simplifyStroke: true,
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

  /**
   * Stable id for the credential this service will actually send.
   * Hashed so a cache key never contains the token. The scheme prefix keeps a
   * personal-access token and an OAuth token with the same string from sharing
   * an entry — HTTP mode builds a new service per request, and two callers of
   * the same file must not see each other's response.
   */
  authFingerprint(): string {
    const secret = this.useOAuth ? `oauth\0${this.oauthToken}` : `pat\0${this.apiKey}`;
    return createHash("sha256").update(secret).digest("hex");
  }

  private getAuthHeaders(): Record<string, string> {
    if (this.useOAuth) {
      Logger.log("Using OAuth Bearer token for authentication");
      return { Authorization: `Bearer ${this.oauthToken}` };
    }

    if (!this.apiKey) {
      throw new Error(
        "Figma API authentication is required. Configure FIGMA_API_KEY or FIGMA_OAUTH_TOKEN on the server, or send X-Figma-Token / Authorization: Bearer on the HTTP request.",
      );
    }

    Logger.log("Using Personal Access Token for authentication");
    return { "X-Figma-Token": this.apiKey };
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
    const { data } = await this.requestWithSize<T>(endpoint);
    return data;
  }

  /**
   * Like `request`, but also surfaces the raw response body size so callers
   * can record it for telemetry. Only used by endpoints whose payload size
   * we care about (`getRawFile` / `getRawNode`); image-fetching endpoints
   * continue to use `request` unchanged.
   */
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
      const svgOptions = options.svgOptions || DEFAULT_SVG_OPTIONS;
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
   * @returns Downloaded images, plus whether any Figma URL lookup was served
   * from `options.imageUrlCache`. The image bytes are always downloaded —
   * the cache holds the temporary Figma URLs, which are what the rate limit
   * counts, and the caller's `localPath` is still written on every call.
   */
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
    options: { pngScale?: number; svgOptions?: SvgOptions; imageUrlCache?: ImageUrlCache } = {},
  ): Promise<{
    images: ImageProcessingResult[];
    cacheHit: boolean;
    cache?: { ageMs: number; ttlMs: number };
  }> {
    if (items.length === 0) return { images: [], cacheHit: false };

    const resolvedPath = localPath;
    const { pngScale = 2, svgOptions = DEFAULT_SVG_OPTIONS, imageUrlCache } = options;
    const downloadPromises: Promise<ImageProcessingResult[]>[] = [];
    const lookup = imageUrlCache?.lookup(this.authFingerprint(), fileKey);

    // Separate items by type: image/gif fills vs rendered nodes
    const imageFills = items.filter(
      (item): item is typeof item & ({ imageRef: string } | { gifRef: string }) =>
        !!item.imageRef || !!item.gifRef,
    );
    const renderNodes = items.filter(
      (item): item is typeof item & { nodeId: string } => !!item.nodeId,
    );

    // Download image fills (static images and animated GIFs) with processing
    if (imageFills.length > 0) {
      const fetchFillUrls = () => this.getImageFillUrls(fileKey);
      const fillRefs = imageFills.flatMap(({ gifRef, imageRef }) => gifRef ?? imageRef ?? []);
      const fillUrls = await (lookup ? lookup.fillUrls(fillRefs, fetchFillUrls) : fetchFillUrls());
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
            // gifRef takes priority when present — it points to the animated GIF file.
            // imageRef only points to a static snapshot frame for GIF nodes.
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

    // Download rendered nodes with processing
    if (renderNodes.length > 0) {
      const pngNodes = renderNodes.filter((node) => !node.fileName.toLowerCase().endsWith(".svg"));
      const svgNodes = renderNodes.filter((node) => node.fileName.toLowerCase().endsWith(".svg"));

      // Download PNG renders
      if (pngNodes.length > 0) {
        const pngIds = pngNodes.map((n) => n.nodeId);
        const fetchPngUrls = (nodeIds: string[]) =>
          this.getNodeRenderUrls(fileKey, nodeIds, "png", { pngScale });
        const pngUrls = await (lookup
          ? lookup.renderUrls(pngIds, { format: "png", pngScale }, fetchPngUrls)
          : fetchPngUrls(pngIds));
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
        const svgIds = svgNodes.map((n) => n.nodeId);
        const fetchSvgUrls = (nodeIds: string[]) =>
          this.getNodeRenderUrls(fileKey, nodeIds, "svg", { svgOptions });
        const svgUrls = await (lookup
          ? lookup.renderUrls(svgIds, { format: "svg", svgOptions }, fetchSvgUrls)
          : fetchSvgUrls(svgIds));
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
    return {
      images: results.flat(),
      ...(lookup?.summary() ?? { cacheHit: false }),
    };
  }

  /**
   * Get raw Figma API response for a file (for use with flexible extractors).
   *
   * Returns the parsed body alongside the raw body size in bytes so callers
   * can record payload size in telemetry.
   */
  async getRawFile(
    fileKey: string,
    depth?: number | null,
  ): Promise<{ data: GetFileResponse; rawSize: number }> {
    const endpoint = `/files/${fileKey}${depth ? `?depth=${depth}` : ""}`;
    Logger.log(`Retrieving raw Figma file: ${fileKey} (depth: ${depth ?? "default"})`);

    const result = await this.requestWithSize<GetFileResponse>(endpoint);
    writeLogs("figma-raw.json", result.data);

    return result;
  }

  /**
   * Get raw Figma API response for specific nodes (for use with flexible extractors).
   *
   * Returns the parsed body alongside the raw body size in bytes so callers
   * can record payload size in telemetry.
   */
  async getRawNode(
    fileKey: string,
    nodeId: string,
    depth?: number | null,
  ): Promise<{ data: GetFileNodesResponse; rawSize: number }> {
    const endpoint = `/files/${fileKey}/nodes?ids=${nodeId}${depth ? `&depth=${depth}` : ""}`;
    Logger.log(
      `Retrieving raw Figma node: ${nodeId} from ${fileKey} (depth: ${depth ?? "default"})`,
    );

    const result = await this.requestWithSize<GetFileNodesResponse>(endpoint);
    writeLogs("figma-raw.json", result.data);

    return result;
  }
}
