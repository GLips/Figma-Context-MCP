import { access, constants, mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import path from "path";
import type { GetFileResponse } from "@figma/rest-api-spec";
import { Logger } from "~/utils/logger.js";

export type FigmaCachingOptions = {
  cacheDir: string;
  ttlMs: number;
};

type StoredFilePayload = {
  fetchedAt: number;
  data: GetFileResponse;
};

export class FigmaFileCache {
  private initPromise: Promise<void>;

  constructor(private readonly options: FigmaCachingOptions) {
    this.initPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      // Create cache directory if it doesn't exist (like mkdir -p)
      await mkdir(this.options.cacheDir, { recursive: true });

      // Validate write permissions
      await access(this.options.cacheDir, constants.W_OK);

      Logger.log(`[FigmaFileCache] Initialized cache directory: ${this.options.cacheDir}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to initialize Figma cache: Cannot write to directory "${this.options.cacheDir}". ${message}`,
      );
    }
  }

  async waitForInit(): Promise<void> {
    await this.initPromise;
  }

  private getCachePath(fileKey: string): string {
    return path.join(this.options.cacheDir, `${fileKey}.json`);
  }

  private isExpired(fetchedAt: number): boolean {
    return Date.now() - fetchedAt > this.options.ttlMs;
  }

  async get(fileKey: string): Promise<GetFileResponse | null> {
    await this.waitForInit();

    // NOTE: Race condition possible - if multiple requests for the same uncached file
    // arrive concurrently, they may all make separate API calls. This is a rare edge case
    // and the complexity of deduplication is not warranted for this use case.

    const cachePath = this.getCachePath(fileKey);

    try {
      const fileContents = await readFile(cachePath, "utf-8");
      const payload = JSON.parse(fileContents) as StoredFilePayload;

      if (!payload?.data || typeof payload.fetchedAt !== "number") {
        Logger.log(`[FigmaFileCache] Cache file corrupted for ${fileKey}, removing`);
        await this.safeDelete(cachePath);
        return null;
      }

      if (this.isExpired(payload.fetchedAt)) {
        Logger.log(`[FigmaFileCache] Cache expired for ${fileKey}`);
        await this.safeDelete(cachePath);
        return null;
      }

      Logger.log(`[FigmaFileCache] Cache hit for ${fileKey}`);
      return payload.data;
    } catch (error: unknown) {
      const err = error as { code?: string; message?: string };
      if (err?.code !== "ENOENT") {
        const message = err?.message ?? String(error);
        Logger.log(`[FigmaFileCache] Error reading cache for ${fileKey}: ${message}`);
      }
      return null;
    }
  }

  async set(fileKey: string, data: GetFileResponse): Promise<void> {
    await this.waitForInit();

    const cachePath = this.getCachePath(fileKey);
    const tempPath = `${cachePath}.tmp`;
    const payload: StoredFilePayload = {
      fetchedAt: Date.now(),
      data,
    };

    try {
      // Write to temporary file first, then atomically rename to avoid corruption
      await writeFile(tempPath, JSON.stringify(payload));
      await rename(tempPath, cachePath);
      Logger.log(`[FigmaFileCache] Cached file ${fileKey}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      Logger.log(`[FigmaFileCache] Failed to write cache for ${fileKey}: ${message}`);
      // Clean up temp file on error
      await this.safeDelete(tempPath);
      throw new Error(`Figma cache write failed: ${message}`);
    }
  }

  private async safeDelete(cachePath: string): Promise<void> {
    try {
      await unlink(cachePath);
    } catch (error: unknown) {
      const err = error as { code?: string; message?: string };
      if (err?.code !== "ENOENT") {
        const message = err?.message ?? String(error);
        Logger.log(`[FigmaFileCache] Error deleting cache file: ${message}`);
      }
    }
  }
}
