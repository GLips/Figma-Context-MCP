import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import type { GetFileResponse } from "@figma/rest-api-spec";
import { FigmaService, type FigmaAuthOptions } from "./figma.js";

const AUTH_OPTIONS: FigmaAuthOptions = {
  figmaApiKey: "test-key",
  figmaOAuthToken: "",
  useOAuth: false,
};

function createSampleFile(): GetFileResponse {
  return {
    name: "Sample",
    lastModified: new Date().toISOString(),
    thumbnailUrl: "",
    version: "1",
    role: "viewer",
    editorType: "figma",
    schemaVersion: 0,
    components: {},
    componentSets: {},
    styles: {},
    document: {
      id: "0:0",
      name: "Document",
      type: "DOCUMENT",
      children: [
        {
          id: "10:20",
          name: "Page",
          type: "CANVAS",
          children: [
            {
              id: "11:22",
              name: "Frame",
              type: "FRAME",
              children: [],
            },
          ],
        },
      ],
    },
  } as unknown as GetFileResponse;
}

async function createCacheDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "figma-service-cache-test-"));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

describe("FigmaService caching", () => {
  it("reuses cached files for repeated getRawFile calls", async () => {
    const cacheDir = await createCacheDir();
    const sample = createSampleFile();
    const requestSpy = spyOnRequest().mockResolvedValue(sample);

    try {
      const service = new FigmaService(AUTH_OPTIONS, { cacheDir, ttlMs: 60_000 });
      const first = await service.getRawFile("FILE123");
      const second = await service.getRawFile("FILE123");

      expect(first.data.name).toBe("Sample");
      expect(second.data.document.id).toBe("0:0");
      expect(requestSpy).toHaveBeenCalledTimes(1);
    } finally {
      requestSpy.mockRestore();
      await cleanup(cacheDir);
    }
  });

  it("serves node lookups from cached file without extra API calls", async () => {
    const cacheDir = await createCacheDir();
    const sample = createSampleFile();
    const requestSpy = spyOnRequest().mockResolvedValue(sample);

    try {
      const service = new FigmaService(AUTH_OPTIONS, { cacheDir, ttlMs: 60_000 });
      const nodeId = "10:20";

      const first = await service.getRawNode("FILE456", nodeId);
      expect(first.data.nodes[nodeId]).toBeDefined();
      expect(requestSpy).toHaveBeenCalledTimes(1);

      await service.getRawNode("FILE456", nodeId);
      expect(requestSpy).toHaveBeenCalledTimes(1);
    } finally {
      requestSpy.mockRestore();
      await cleanup(cacheDir);
    }
  });
});
function spyOnRequest() {
  return jest.spyOn(
    FigmaService.prototype as unknown as {
      request: (endpoint: string) => Promise<unknown>;
    },
    "request",
  );
}
