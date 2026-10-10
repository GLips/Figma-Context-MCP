import type {
  GetImagesResponse,
  GetFileResponse,
  GetFileNodesResponse,
  GetImageFillsResponse,
  GetComponentResponse,
  GetCommentsResponse,
  Transform,
} from "@figma/rest-api-spec";
import {
  downloadAndProcessImage,
  limitConcurrency,
  type ImageDestination,
  type ImageLimits,
  type ImageProcessingResult,
} from "~/utils/image-processing.js";
import { Logger, writeLogs } from "~/utils/logger.js";
import { fetchJSON, HttpError } from "~/utils/fetch-json.js";
import { getErrorMeta, tagError } from "~/utils/error-meta.js";
import { buildForbiddenMessage, buildRateLimitMessage } from "./errors/index.js";

export type FigmaAuthOptions = {
  figmaApiKey: string;
  figmaOAuthToken: string;
  useOAuth: boolean;
};

/** One Figma credential: a personal access token or an OAuth bearer token. */
export type FigmaCredential = { kind: "pat" | "oauth"; token: string };

/**
 * Where a FigmaService gets its credential. Resolved lazily — on the first Figma call, never on
 * construction — so a host that looks credentials up per user pays nothing for `initialize` or
 * `tools/list`.
 */
export type FigmaCredentialSource = {
  /** A thrown error's message reaches the agent, so make it actionable and secret-free. */
  resolve(opts: { signal: AbortSignal }): Promise<FigmaCredential>;
  /**
   * Figma rejected the resolved credential itself (401, or a 403 naming the token); drop any
   * cached copy. Never called for a file-permission 403 — that credential is still good.
   */
  invalidate(): void;
};

export type FigmaServiceOptions = {
  /** Aborts every Figma API call, image download and image store this service makes. */
  signal?: AbortSignal;
  /** Refuse Figma API responses larger than this, counted while streaming. */
  maxResponseBytes?: number;
  images?: ImageLimits;
};

/** The startup credential as a source: missing credentials fail the call that needed them. */
function staticCredentialSource({
  figmaApiKey,
  figmaOAuthToken,
  useOAuth,
}: FigmaAuthOptions): FigmaCredentialSource {
  return {
    async resolve() {
      if (useOAuth && figmaOAuthToken) return { kind: "oauth", token: figmaOAuthToken };
      if (figmaApiKey) return { kind: "pat", token: figmaApiKey };
      tagError(
        new Error(
          "Figma API authentication is required. Configure FIGMA_API_KEY or FIGMA_OAUTH_TOKEN on the server, or send X-Figma-Token / Authorization: Bearer on the HTTP request.",
        ),
        { category: "missing_credentials" },
      );
    },
    invalidate() {},
  };
}

/**
 * Whether Figma refused the credential rather than access to the file. A 401 always does; a 403
 * does only when its `err` names the token ("Invalid token", "Token expired") — a 403 for a file
 * the account can't open says nothing about the credential.
 */
function isCredentialRejection(error: unknown): boolean {
  const status = getErrorMeta(error).http_status;
  if (status === 401) return true;
  if (status !== 403 || !(error instanceof HttpError) || !error.responseBody) return false;
  try {
    const { err } = JSON.parse(error.responseBody) as { err?: unknown };
    return typeof err === "string" && /\btoken\b/i.test(err);
  } catch {
    return false;
  }
}

type SvgOptions = {
  outlineText: boolean;
  includeId: boolean;
  simplifyStroke: boolean;
};

export class FigmaService {
  private readonly credentials: FigmaCredentialSource;
  private readonly options: FigmaServiceOptions;
  private readonly baseUrl = "https://api.figma.com/v1";

  constructor(
    credentials: FigmaAuthOptions | FigmaCredentialSource,
    options: FigmaServiceOptions = {},
  ) {
    this.credentials = "resolve" in credentials ? credentials : staticCredentialSource(credentials);
    this.options = options;
  }

  private getAuthHeaders({ kind, token }: FigmaCredential): Record<string, string> {
    if (kind === "oauth") {
      Logger.log("Using OAuth Bearer token for authentication");
      return { Authorization: `Bearer ${token}` };
    }
    Logger.log("Using Personal Access Token for authentication");
    return { "X-Figma-Token": token };
  }

  private signalFor(signal: AbortSignal | undefined): AbortSignal | undefined {
    const own = this.options.signal;
    if (!own) return signal;
    return signal ? AbortSignal.any([own, signal]) : own;
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

  private async request<T>(endpoint: string, signal?: AbortSignal): Promise<T> {
    const { data } = await this.requestWithSize<T>(endpoint, signal);
    return data;
  }

  /**
   * Like `request`, but also surfaces the raw response body size so callers
   * can record it for telemetry. Only used by endpoints whose payload size
   * we care about (`getRawFile` / `getRawNode`); image-fetching endpoints
   * continue to use `request` unchanged.
   */
  private async requestWithSize<T>(
    endpoint: string,
    signal?: AbortSignal,
  ): Promise<{ data: T; rawSize: number }> {
    try {
      Logger.log(`Calling ${this.baseUrl}${endpoint}`);
      const requestSignal = this.signalFor(signal);
      const credential = await this.credentials.resolve({
        signal: requestSignal ?? new AbortController().signal,
      });

      return await fetchJSON<T & { status?: number }>(`${this.baseUrl}${endpoint}`, {
        headers: this.getAuthHeaders(credential),
        signal: requestSignal,
        redactFromResponseBody: [credential.token],
        maxBytes: this.options.maxResponseBytes,
      });
    } catch (error) {
      const meta = getErrorMeta(error);
      if (isCredentialRejection(error)) this.credentials.invalidate();
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
   * @returns One result per successfully downloaded image
   */
  async downloadImages(
    fileKey: string,
    destination: ImageDestination,
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

    const { pngScale = 2, svgOptions } = options;
    const limits = this.options.images ?? {};
    const signal = this.options.signal;
    // Per call: bounds this request's fan-out through download, decode and store.
    const runJob = limitConcurrency(limits.maxConcurrent);
    const processImage = (
      fileName: string,
      imageUrl: string,
      needsCropping: boolean | undefined,
      cropTransform: Transform | undefined,
      requiresImageDimensions: boolean | undefined,
    ) =>
      runJob(() =>
        downloadAndProcessImage(
          fileName,
          destination,
          imageUrl,
          needsCropping,
          cropTransform,
          requiresImageDimensions,
          { limits, signal },
        ),
      );
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
              ? processImage(
                  fileName,
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
              ? processImage(
                  fileName,
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
              ? processImage(
                  fileName,
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

  /**
   * Several nodes in ONE call — the component-definition fetch, which asks for every off-tree
   * definition a read referenced at once. Separate from `getRawNode` because it is a supplementary
   * fetch: its size is not the read's payload, and the caller treats any failure as "fall back to
   * the donated instance" rather than failing the read.
   */
  async getRawNodes(fileKey: string, nodeIds: string[]): Promise<GetFileNodesResponse> {
    const endpoint = `/files/${fileKey}/nodes?ids=${nodeIds.join(",")}`;
    Logger.log(`Retrieving ${nodeIds.length} node(s) from ${fileKey}`);
    return this.request<GetFileNodesResponse>(endpoint);
  }

  /**
   * Where a PUBLISHED component's definition actually lives. A remote component's `componentId` is
   * local to the consuming file and addresses no node there; its publish `key` is the only handle
   * that crosses files, and this endpoint trades that key for the library's file key and node id.
   * Needs read access to the library — a separate grant from access to the file being read.
   */
  async getPublishedComponentSite(key: string): Promise<{ fileKey: string; nodeId: string }> {
    const response = await this.request<GetComponentResponse>(`/components/${key}`);
    return { fileKey: response.meta.file_key, nodeId: response.meta.node_id };
  }

  /**
   * Every comment on the file, replies included, with Markdown bodies. Tier 2 — the comments tool's
   * one cheap call. Needs the `file_comments:read` scope, which a file-content-only token lacks.
   */
  async getComments(fileKey: string, signal?: AbortSignal): Promise<GetCommentsResponse> {
    return this.request<GetCommentsResponse>(`/files/${fileKey}/comments?as_md=true`, signal);
  }

  /**
   * The document with every page listed but only `nodeIds`' subtrees (and their ancestor chains)
   * filled in — or, with no ids, the page list alone. Tier 1.
   *
   * Never pass a page id here: its "subtree" is the whole page.
   */
  async getFileSlice(fileKey: string, nodeIds: string[]): Promise<GetFileResponse> {
    const query = nodeIds.length ? `ids=${nodeIds.join(",")}` : "depth=1";
    return this.request<GetFileResponse>(`/files/${fileKey}?${query}`);
  }
}
