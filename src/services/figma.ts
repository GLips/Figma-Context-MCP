import type {
  GetImagesResponse,
  GetFileResponse,
  GetFileNodesResponse,
  GetImageFillsResponse,
  GetComponentResponse,
  GetCommentsResponse,
  Transform,
} from "@figma/rest-api-spec";
import { limitConcurrency } from "~/utils/concurrency.js";
import {
  downloadAndProcessImage,
  type ImageDestination,
  type ImageLimits,
  type ImageProcessingResult,
} from "~/utils/image-processing.js";
import { Logger, writeLogs } from "~/utils/logger.js";
import { fetchJSON } from "~/utils/fetch-json.js";
import { getErrorMeta, tagError } from "~/utils/error-meta.js";
import type { FigmaFileKey, FigmaNodeId } from "~/utils/figma-url.js";
import {
  buildForbiddenMessage,
  buildRateLimitMessage,
  isCredentialRejection,
} from "./errors/index.js";

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

/**
 * A credential resolved up front as a source. Absent is a real state — an HTTP server with no
 * global credential, serving a request that sent none — and fails the call that needed one.
 */
export function staticCredentialSource(
  credential: FigmaCredential | undefined,
): FigmaCredentialSource {
  return {
    async resolve() {
      if (credential) return credential;
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

type SvgOptions = {
  outlineText: boolean;
  includeId: boolean;
  simplifyStroke: boolean;
};

/** One file to save. An `imageRef`/`gifRef` downloads an image fill; a bare `nodeId` renders the node. */
export type ImageDownloadItem = {
  imageRef?: string;
  gifRef?: string;
  nodeId?: FigmaNodeId;
  fileName: string;
  needsCropping?: boolean;
  cropTransform?: Transform;
  requiresImageDimensions?: boolean;
};

/** `not_rendered`: Figma returned no URL for the fill or node, so there was nothing to fetch. */
export type ImageDownloadOutcome =
  | { status: "written"; result: ImageProcessingResult }
  | { status: "not_rendered" }
  | { status: "failed"; error: unknown };

/**
 * Build an API endpoint: each path segment URI-encoded, the query through URLSearchParams with
 * unset params dropped. Callers pass ids as given, so nothing they contain can rewrite the URL.
 */
function figmaEndpoint(
  segments: string[],
  query: Record<string, string | number | boolean | undefined> = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const path = `/${segments.map(encodeURIComponent).join("/")}`;
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

export class FigmaService {
  private readonly credentials: FigmaCredentialSource;
  private readonly options: FigmaServiceOptions;
  private readonly baseUrl = "https://api.figma.com/v1";

  constructor(credentials: FigmaCredentialSource, options: FigmaServiceOptions = {}) {
    this.credentials = credentials;
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

  /**
   * This service, scoped to one caller's lifetime: every Figma call, image download and store it
   * makes also aborts on `signal` (a cancelled tool call, a finished plugin run). Shares the
   * credential source, so a cached credential is still resolved once.
   */
  withSignal(signal: AbortSignal): FigmaService {
    const own = this.options.signal;
    return new FigmaService(this.credentials, {
      ...this.options,
      signal: own ? AbortSignal.any([own, signal]) : signal,
    });
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
   * we care about (`getRawFile` / `getRawNodeInContext`); image-fetching endpoints
   * continue to use `request` unchanged.
   */
  private async requestWithSize<T>(endpoint: string): Promise<{ data: T; rawSize: number }> {
    try {
      Logger.log(`Calling ${this.baseUrl}${endpoint}`);
      const { signal } = this.options;
      const credential = await this.credentials.resolve({
        signal: signal ?? new AbortController().signal,
      });

      return await fetchJSON<T>(`${this.baseUrl}${endpoint}`, {
        headers: this.getAuthHeaders(credential),
        signal,
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
   * Gets download URLs for image fills without downloading them.
   *
   * @returns Map of imageRef to download URL
   */
  async getImageFillUrls(fileKey: FigmaFileKey): Promise<Record<string, string>> {
    const response = await this.request<GetImageFillsResponse>(
      figmaEndpoint(["files", fileKey, "images"]),
    );
    return response.meta.images || {};
  }

  /**
   * Gets download URLs for rendered nodes without downloading them.
   *
   * @returns Map of node ID to download URL
   */
  async getNodeRenderUrls(
    fileKey: FigmaFileKey,
    nodeIds: FigmaNodeId[],
    format: "png" | "svg",
    options: { pngScale?: number; svgOptions?: SvgOptions } = {},
  ): Promise<Record<string, string>> {
    if (nodeIds.length === 0) return {};

    const svg = options.svgOptions ?? { outlineText: true, includeId: false, simplifyStroke: true };
    const formatParams =
      format === "png"
        ? { scale: options.pngScale || 2 }
        : {
            svg_outline_text: svg.outlineText,
            svg_include_id: svg.includeId,
            svg_simplify_stroke: svg.simplifyStroke,
          };
    const response = await this.request<GetImagesResponse>(
      figmaEndpoint(["images", fileKey], { ids: nodeIds.join(","), format, ...formatParams }),
    );
    return this.filterValidImages(response.images);
  }

  /**
   * Download and post-process (crop, measure) every item, each settling on its own: one failure
   * or unrendered node doesn't sink the rest. Every item comes back paired with its outcome, so
   * callers match results by item, never by position.
   */
  async downloadImages<T extends ImageDownloadItem>(
    fileKey: FigmaFileKey,
    destination: ImageDestination,
    items: T[],
    options: { pngScale?: number; svgOptions?: SvgOptions } = {},
  ): Promise<Array<{ item: T; outcome: ImageDownloadOutcome }>> {
    if (items.length === 0) return [];

    const { pngScale = 2, svgOptions } = options;
    const limits = this.options.images ?? {};
    // Per call: bounds this request's fan-out through download, decode and store.
    const runJob = limitConcurrency(limits.maxConcurrent);
    // gifRef takes priority when present — it points to the animated GIF file.
    // imageRef only points to a static snapshot frame for GIF nodes.
    const fillRefOf = (item: T) => item.gifRef ?? item.imageRef;
    const isSvg = (item: T) => item.fileName.toLowerCase().endsWith(".svg");
    const renderIds = (svg: boolean) =>
      items.flatMap((item) =>
        !fillRefOf(item) && item.nodeId && isSvg(item) === svg ? [item.nodeId] : [],
      );

    const [fillUrls, pngUrls, svgUrls] = await Promise.all([
      items.some(fillRefOf)
        ? this.getImageFillUrls(fileKey)
        : Promise.resolve<Record<string, string>>({}),
      this.getNodeRenderUrls(fileKey, renderIds(false), "png", { pngScale }),
      this.getNodeRenderUrls(fileKey, renderIds(true), "svg", { svgOptions }),
    ]);

    const urlFor = (item: T): string | undefined => {
      const fillRef = fillRefOf(item);
      if (fillRef) return fillUrls[fillRef];
      if (item.nodeId) return (isSvg(item) ? svgUrls : pngUrls)[item.nodeId];
      return undefined;
    };

    const settled = await Promise.allSettled(
      items.map((item) => {
        const imageUrl = urlFor(item);
        return imageUrl
          ? runJob(() =>
              downloadAndProcessImage(
                item.fileName,
                destination,
                imageUrl,
                item.needsCropping,
                item.cropTransform,
                item.requiresImageDimensions,
                { limits, signal: this.options.signal },
              ),
            )
          : null;
      }),
    );

    return items.map((item, index) => {
      const settlement = settled[index];
      const outcome: ImageDownloadOutcome =
        settlement.status === "rejected"
          ? { status: "failed", error: settlement.reason }
          : settlement.value
            ? { status: "written", result: settlement.value }
            : { status: "not_rendered" };
      return { item, outcome };
    });
  }

  /**
   * Get raw Figma API response for a file (for use with flexible extractors).
   *
   * Returns the parsed body alongside the raw body size in bytes so callers
   * can record payload size in telemetry.
   */
  async getRawFile(
    fileKey: FigmaFileKey,
    depth?: number | null,
  ): Promise<{ data: GetFileResponse; rawSize: number }> {
    const endpoint = figmaEndpoint(["files", fileKey], { depth: depth ?? undefined });
    Logger.log(`Retrieving raw Figma file: ${fileKey} (depth: ${depth ?? "default"})`);

    const result = await this.requestWithSize<GetFileResponse>(endpoint);
    writeLogs("figma-raw.json", result.data);

    return result;
  }

  /**
   * One node with its ancestor chain: the document filtered by `ids`, which is what lets a read
   * place the node in its real parent. Each ancestor lists only the child on the path, so the chain
   * costs its own bodies (plus a stub per page), not its siblings. No `depth`: alongside `ids`,
   * Figma counts it from the document root rather than from the node, so the read cuts depth itself.
   *
   * Returns the parsed body alongside the raw body size in bytes so callers
   * can record payload size in telemetry.
   */
  async getRawNodeInContext(
    fileKey: FigmaFileKey,
    nodeId: FigmaNodeId,
  ): Promise<{ data: GetFileResponse; rawSize: number }> {
    Logger.log(`Retrieving raw Figma node in context: ${nodeId} from ${fileKey}`);

    const result = await this.requestWithSize<GetFileResponse>(
      figmaEndpoint(["files", fileKey], { ids: nodeId }),
    );
    writeLogs("figma-raw.json", result.data);

    return result;
  }

  /**
   * Several nodes in ONE call — the component-definition fetch, which asks for every off-tree
   * definition a read referenced at once, and a grid parent's children. Separate from
   * `getRawNodeInContext` because it is a supplementary fetch: its size is not the read's payload,
   * and the callers treat any failure as a fallback rather than failing the read.
   */
  async getRawNodes(
    fileKey: FigmaFileKey,
    nodeIds: string[],
    depth?: number,
  ): Promise<GetFileNodesResponse> {
    const endpoint = figmaEndpoint(["files", fileKey, "nodes"], { ids: nodeIds.join(","), depth });
    Logger.log(`Retrieving ${nodeIds.length} node(s) from ${fileKey}`);
    return this.request<GetFileNodesResponse>(endpoint);
  }

  /**
   * Where a PUBLISHED component's definition actually lives. A remote component's `componentId` is
   * local to the consuming file and addresses no node there; its publish `key` is the only handle
   * that crosses files, and this endpoint trades that key for the library's file key and node id.
   * Needs read access to the library — a separate grant from access to the file being read.
   */
  async getPublishedComponentSite(key: string): Promise<{ fileKey: FigmaFileKey; nodeId: string }> {
    const response = await this.request<GetComponentResponse>(figmaEndpoint(["components", key]));
    // Figma's own answer names a file it serves, so it needs no input-edge check.
    return { fileKey: response.meta.file_key as FigmaFileKey, nodeId: response.meta.node_id };
  }

  /**
   * Every comment on the file, replies included, with Markdown bodies. Tier 2 — the comments tool's
   * one cheap call. Needs the `file_comments:read` scope, which a file-content-only token lacks.
   */
  async getComments(fileKey: FigmaFileKey): Promise<GetCommentsResponse> {
    return this.request<GetCommentsResponse>(
      figmaEndpoint(["files", fileKey, "comments"], { as_md: true }),
    );
  }

  /**
   * The document with every page listed but only `nodeIds`' subtrees (and their ancestor chains)
   * filled in — or, with no ids, the page list alone. Tier 1.
   *
   * Never pass a page id here: its "subtree" is the whole page.
   */
  async getFileSlice(fileKey: FigmaFileKey, nodeIds: string[]): Promise<GetFileResponse> {
    const query = nodeIds.length ? { ids: nodeIds.join(",") } : { depth: 1 };
    return this.request<GetFileResponse>(figmaEndpoint(["files", fileKey], query));
  }
}
