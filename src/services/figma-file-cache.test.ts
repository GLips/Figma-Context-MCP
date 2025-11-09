import { mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { FigmaFileCache } from "./figma-file-cache.js";
import type { GetFileResponse } from "@figma/rest-api-spec";

const SAMPLE_FILE: GetFileResponse = {
  name: "Test File",
  lastModified: new Date().toISOString(),
  thumbnailUrl: "",
  version: "1",
  role: "viewer",
  editorType: "figma",
  document: {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    children: [],
  },
  schemaVersion: 0,
  components: {},
  componentSets: {},
  styles: {},
} as unknown as GetFileResponse;

async function createTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "figma-file-cache-test-"));
}

async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

describe("FigmaFileCache", () => {
  it("stores and retrieves cached entries", async () => {
    const dir = await createTempDir();
    try {
      const cache = new FigmaFileCache({ cacheDir: dir, ttlMs: 60_000 });

      await cache.set("ABC", SAMPLE_FILE);
      const loaded = await cache.get("ABC");

      expect(loaded?.name).toBe("Test File");
    } finally {
      await cleanupDir(dir);
    }
  });

  it("expires entries when ttl is exceeded", async () => {
    const dir = await createTempDir();
    const cache = new FigmaFileCache({ cacheDir: dir, ttlMs: 10 });
    const dateSpy = jest.spyOn(Date, "now");
    try {
      dateSpy.mockReturnValue(1000);
      await cache.set("ABC", SAMPLE_FILE);

      dateSpy.mockReturnValue(1000 + 11);
      const loaded = await cache.get("ABC");

      expect(loaded).toBeNull();
    } finally {
      dateSpy.mockRestore();
      await cleanupDir(dir);
    }
  });

  it("handles corrupted cache files gracefully", async () => {
    const dir = await createTempDir();
    try {
      const filePath = path.join(dir, "ABC.json");
      await writeFile(filePath, "not-json");

      const cache = new FigmaFileCache({ cacheDir: dir, ttlMs: 60_000 });
      const loaded = await cache.get("ABC");

      expect(loaded).toBeNull();
    } finally {
      await cleanupDir(dir);
    }
  });
});
