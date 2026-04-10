import type { Transform } from "@figma/rest-api-spec";
import type { FigmaService } from "~/services/figma.js";
import type { ImageProcessingResult } from "~/utils/image-processing.js";
import { tagError } from "~/utils/error-meta.js";

/**
 * Structural shape for a single download request. Matches the relevant
 * fields of the tool's zod schema without coupling the core to the schema
 * itself — callers can pass any object that conforms.
 */
export type DownloadImageNode = {
  nodeId: string;
  imageRef?: string;
  gifRef?: string;
  fileName: string;
  needsCropping?: boolean;
  cropTransform?: Transform;
  requiresImageDimensions?: boolean;
  filenameSuffix?: string;
};

export type DownloadFigmaImagesInput = {
  fileKey: string;
  nodes: DownloadImageNode[];
  localPath: string;
  pngScale?: number;
};

export type DownloadFigmaImagesResult = {
  downloads: Array<{
    result: ImageProcessingResult;
    requestedFileNames: string[];
  }>;
  successCount: number;
};

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
 * and return per-download results keyed back to the original requested
 * filenames so the caller can render aliases.
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
    const { fileKey, nodes, localPath, pngScale } = input;

    // Resolve the set of unique downloads and track which requested
    // filenames each one satisfies (so the caller can render aliases).
    const downloadItems: Array<{
      fileName: string;
      needsCropping: boolean;
      cropTransform?: Transform;
      requiresImageDimensions: boolean;
      imageRef?: string;
      gifRef?: string;
      nodeId?: string;
    }> = [];
    const downloadToRequests = new Map<number, string[]>();
    const seenDownloads = new Map<string, number>();

    for (const rawNode of nodes) {
      const { nodeId: rawNodeId, ...node } = rawNode;

      // Replace - with : in nodeId for our query — Figma API expects :.
      const nodeId = rawNodeId?.replace(/-/g, ":");

      let finalFileName = node.fileName;
      if (node.filenameSuffix && !finalFileName.includes(node.filenameSuffix)) {
        const ext = finalFileName.split(".").pop();
        const nameWithoutExt = finalFileName.substring(0, finalFileName.lastIndexOf("."));
        finalFileName = `${nameWithoutExt}-${node.filenameSuffix}.${ext}`;
      }

      const downloadItem = {
        fileName: finalFileName,
        needsCropping: node.needsCropping || false,
        cropTransform: node.cropTransform,
        requiresImageDimensions: node.requiresImageDimensions || false,
      };

      if (node.gifRef) {
        // GIF fills are always unique downloads (animated, no dedup needed).
        const downloadIndex = downloadItems.length;
        downloadItems.push({ ...downloadItem, gifRef: node.gifRef });
        downloadToRequests.set(downloadIndex, [finalFileName]);
      } else if (node.imageRef) {
        const uniqueKey = `${node.imageRef}-${node.filenameSuffix || "none"}`;

        if (!node.filenameSuffix && seenDownloads.has(uniqueKey)) {
          const downloadIndex = seenDownloads.get(uniqueKey)!;
          const requests = downloadToRequests.get(downloadIndex)!;
          if (!requests.includes(finalFileName)) {
            requests.push(finalFileName);
          }

          if (downloadItem.requiresImageDimensions) {
            downloadItems[downloadIndex].requiresImageDimensions = true;
          }
        } else {
          const downloadIndex = downloadItems.length;
          downloadItems.push({ ...downloadItem, imageRef: node.imageRef });
          downloadToRequests.set(downloadIndex, [finalFileName]);
          seenDownloads.set(uniqueKey, downloadIndex);
        }
      } else {
        // Rendered nodes are always unique.
        const downloadIndex = downloadItems.length;
        downloadItems.push({ ...downloadItem, nodeId });
        downloadToRequests.set(downloadIndex, [finalFileName]);
      }
    }

    await hooks.onDownloadStart?.(downloadItems.length);
    let allDownloads: ImageProcessingResult[];
    try {
      allDownloads = await figmaService.downloadImages(fileKey, localPath, downloadItems, {
        pngScale,
      });
    } catch (error) {
      tagError(error, { phase: "download" });
    } finally {
      hooks.onDownloadComplete?.();
    }

    successCount = allDownloads.filter(Boolean).length;

    const downloads = allDownloads.map((result, index) => ({
      result,
      requestedFileNames: downloadToRequests.get(index) ?? [result.filePath],
    }));

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
