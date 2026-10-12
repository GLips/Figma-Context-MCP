import type { Transform } from "@figma/rest-api-spec";
import type { FigmaService, ImageDownloadItem, ImageDownloadOutcome } from "~/services/figma.js";
import { tagError } from "~/utils/error-meta.js";
import type { ImageDestination } from "~/utils/image-processing.js";
import type { FigmaFileKey, FigmaNodeId } from "~/utils/figma-url.js";

/**
 * Structural shape for a single download request. Matches the relevant
 * fields of the tool's zod schema without coupling the core to the schema
 * itself — callers can pass any object that conforms.
 */
export type DownloadImageNode = {
  nodeId: FigmaNodeId;
  imageRef?: string;
  gifRef?: string;
  fileName: string;
  needsCropping?: boolean;
  cropTransform?: Transform;
  requiresImageDimensions?: boolean;
  filenameSuffix?: string;
};

export type DownloadFigmaImagesInput = {
  fileKey: FigmaFileKey;
  nodes: DownloadImageNode[];
  destination: ImageDestination;
  pngScale?: number;
};

export type DownloadFigmaImagesResult = {
  /**
   * One entry per unique download. `aliases` are the other requested filenames that this file
   * satisfies (deduplicated image fills) — they are not written to disk.
   */
  downloads: Array<{
    fileName: string;
    aliases: string[];
    outcome: ImageDownloadOutcome;
  }>;
  /** Downloads whose file was written. */
  successCount: number;
};

/** A unique download plus the other requested filenames its file satisfies. */
type PendingDownload = ImageDownloadItem & { aliases: string[] };

export type DownloadImagesOutcome = {
  input: DownloadFigmaImagesInput;
  durationMs: number;
  imageCount: number;
  successCount?: number;
  error?: unknown;
};

export type DownloadFigmaImagesHooks = {
  onDownloadStart?: (downloadCount: number) => void | Promise<void>;
  onDownloadComplete?: () => void;
  /**
   * Fires exactly once per call, after the pipeline completes (success or
   * failure). Observer errors are swallowed silently — a broken observer
   * must never break the pipeline.
   */
  onComplete?: (outcome: DownloadImagesOutcome) => void;
};

/**
 * Shared pipeline for "download figma images": resolve the set of unique
 * downloads (deduping image fills by imageRef), invoke the Figma service,
 * and return each download's outcome with the requested filenames it
 * satisfies so the caller can render aliases.
 *
 * Param parsing, path validation, and MCP-specific result formatting stay
 * at the edge in the tool handler.
 */
export async function downloadFigmaImages(
  figmaService: FigmaService,
  input: DownloadFigmaImagesInput,
  hooks: DownloadFigmaImagesHooks = {},
): Promise<DownloadFigmaImagesResult> {
  const startedAt = Date.now();
  const imageCount = input.nodes.length;
  let successCount: number | undefined;
  let caughtError: unknown;

  try {
    const { fileKey, nodes, destination, pngScale } = input;

    // Resolve the set of unique downloads. Each carries the other requested
    // filenames it satisfies, so the alias text travels with the item itself.
    const downloadItems: PendingDownload[] = [];
    const seenFills = new Map<string, PendingDownload>();

    for (const node of nodes) {
      let fileName = node.fileName;
      if (node.filenameSuffix && !fileName.includes(node.filenameSuffix)) {
        const ext = fileName.split(".").pop();
        const nameWithoutExt = fileName.substring(0, fileName.lastIndexOf("."));
        fileName = `${nameWithoutExt}-${node.filenameSuffix}.${ext}`;
      }

      const downloadItem: PendingDownload = {
        fileName,
        needsCropping: node.needsCropping || false,
        cropTransform: node.cropTransform,
        requiresImageDimensions: node.requiresImageDimensions || false,
        aliases: [],
      };

      if (node.gifRef) {
        // GIF fills are always unique downloads (animated, no dedup needed).
        downloadItems.push({ ...downloadItem, gifRef: node.gifRef });
      } else if (node.imageRef) {
        const uniqueKey = `${node.imageRef}-${node.filenameSuffix || "none"}`;
        const seen = node.filenameSuffix ? undefined : seenFills.get(uniqueKey);

        if (seen) {
          if (fileName !== seen.fileName && !seen.aliases.includes(fileName)) {
            seen.aliases.push(fileName);
          }
          if (downloadItem.requiresImageDimensions) {
            seen.requiresImageDimensions = true;
          }
        } else {
          const item = { ...downloadItem, imageRef: node.imageRef };
          downloadItems.push(item);
          seenFills.set(uniqueKey, item);
        }
      } else {
        // Rendered nodes are always unique.
        downloadItems.push({ ...downloadItem, nodeId: node.nodeId });
      }
    }

    await hooks.onDownloadStart?.(downloadItems.length);
    let settled: Array<{ item: PendingDownload; outcome: ImageDownloadOutcome }>;
    try {
      settled = await figmaService.downloadImages(fileKey, destination, downloadItems, {
        pngScale,
      });
    } catch (error) {
      tagError(error, { phase: "download" });
    } finally {
      hooks.onDownloadComplete?.();
    }

    const downloads = settled.map(({ item, outcome }) => ({
      fileName: item.fileName,
      aliases: item.aliases,
      outcome,
    }));
    successCount = downloads.filter(({ outcome }) => outcome.status === "written").length;

    return { downloads, successCount };
  } catch (error) {
    caughtError = error;
    throw error;
  } finally {
    if (hooks.onComplete) {
      try {
        hooks.onComplete({
          input,
          durationMs: Date.now() - startedAt,
          imageCount,
          successCount,
          error: caughtError,
        });
      } catch {
        // intentionally empty
      }
    }
  }
}
