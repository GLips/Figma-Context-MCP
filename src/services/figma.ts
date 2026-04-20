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
import { proxyMode } from "~/utils/proxy-env.js";
import type { HttpError } from "~/utils/fetch-json.js";

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
        redactFromErrorBody: [this.apiKey, this.oauthToken],
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

/**
 * Build a user-facing 429 message from the Figma rate-limit response headers.
 * Figma includes plan tier, seat-level limit type, retry-after, and an upgrade
 * link — all of which let us give targeted guidance instead of a generic
 * "try again later."
 *
 * See https://developers.figma.com/docs/rest-api/rate-limits/
 */
function buildForbiddenMessage(endpoint: string, error: unknown): string {
  const body = (error as HttpError)?.responseBody;
  const parts = [`Request to Figma API endpoint '${endpoint}' returned 403 Forbidden.`];
  if (body) {
    parts.push(`Response body: ${body}`);
  }
  parts.push(
    "This is typically one of:",
    "- The access token doesn't have permission to this file (it must be owned by or explicitly shared with the token's account)",
    "- The file's share settings don't allow viewers to copy/share/export",
    "- For team/org files, the API token may not have access to that team",
    "- An HTTP intermediary (corporate proxy, firewall, VPN) rejected the request before it reached Figma — check the response body above for clues",
    "Troubleshooting guide: https://www.framelink.ai/docs/troubleshooting#cannot-access-file",
  );
  const mode = proxyMode();
  if (mode !== "none") {
    parts.push(
      "",
      mode === "explicit"
        ? "Note: this server is configured to route requests through an explicit proxy (--proxy/FIGMA_PROXY). If the proxy may be the source of the 403, unset it, change it to --proxy=none, or bypass it for this host."
        : "Note: this server picked up a proxy from HTTP_PROXY/HTTPS_PROXY in your environment. If the proxy may be the source of the 403, set NO_PROXY=api.figma.com, pass --proxy=none, or unset HTTP_PROXY/HTTPS_PROXY.",
    );
  }
  return parts.join("\n");
}

function buildRateLimitMessage(error: unknown): string {
  const headers = (error as HttpError)?.responseHeaders ?? {};
  const retryAfter = headers["retry-after"];
  const planTier = headers["x-figma-plan-tier"];
  const limitType = headers["x-figma-rate-limit-type"];
  const upgradeLink = headers["x-figma-upgrade-link"];

  let message = "Figma API rate limit hit (429).";

  if (retryAfter) {
    message += ` Retry after ${retryAfter} seconds.`;
  }

  if (limitType === "low") {
    message += " Your Figma seat type (Viewer or Collaborator) has a lower API rate limit.";
  }

  if (planTier === "starter" || planTier === "student") {
    message += ` Your ${planTier} plan has limited API access.`;
  }

  if (upgradeLink) {
    message += ` Upgrade: ${upgradeLink}`;
  }

  message += " See https://developers.figma.com/docs/rest-api/rate-limits/";
  return message;
}
