import fs from "fs";
import os from "os";
import path from "path";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDownloadImages, type DownloadImagesFlags } from "~/commands/download-images.js";

const Jimp = createJimp({ formats: [png] });

const FIGMA_API = "https://api.figma.com/v1";
const RENDER_HOST = "https://figma-alpha-api.s3.us-west-2.amazonaws.com";

describe("download-images command", () => {
  let tmpDir: string;
  let imageDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  // Figma's images endpoint maps node IDs to render URLs, or null when it
  // can't render a node.
  let renderUrls: Record<string, string | null>;
  let renderBody: () => Promise<BodyInit>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-images-command-test-"));
    imageDir = path.join(tmpDir, "exports");
    renderUrls = {};
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(`${FIGMA_API}/images/`)) {
        return Response.json({ err: null, images: renderUrls });
      }
      if (url.startsWith(RENDER_HOST)) {
        return new Response(await renderBody());
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(flags: DownloadImagesFlags, positionals: string[] = []) {
    return runDownloadImages(
      {
        figmaApiKey: "test-key",
        noTelemetry: true,
        // Point at a file that doesn't exist so a developer's own .env
        // (e.g. one setting IMAGE_DIR) can't leak into the test.
        env: path.join(tmpDir, "missing.env"),
        imageDir,
        ...flags,
      },
      positionals,
    );
  }

  function figmaApiRequests(): URL[] {
    return fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.href.startsWith(FIGMA_API));
  }

  it("exports the URL's node and extra --node-id nodes as PNGs at the requested scale", async () => {
    const pngBytes = await new Jimp({ width: 40, height: 20, color: 0xff0000ff }).getBuffer(
      "image/png",
    );
    renderBody = async () => new Uint8Array(pngBytes);
    renderUrls = { "1:2": `${RENDER_HOST}/a.png`, "3:4": `${RENDER_HOST}/b.png` };

    const result = await run({ nodeId: ["1-2", "3:4", "1:2"], scale: 3 }, [
      "https://www.figma.com/design/AbC123/My-File?node-id=9-9",
    ]);

    // Explicit --node-id wins over the URL's node, and the dash/colon forms of
    // the same node are only exported once.
    const [request] = figmaApiRequests();
    expect(request.pathname).toBe("/v1/images/AbC123");
    expect(request.searchParams.get("ids")).toBe("1:2,3:4");
    expect(request.searchParams.get("format")).toBe("png");
    expect(request.searchParams.get("scale")).toBe("3");

    expect(result.imageDir).toBe(imageDir);
    expect(result.missingNodeIds).toEqual([]);
    expect(result.filePaths.sort()).toEqual([
      path.join(imageDir, "1-2.png"),
      path.join(imageDir, "3-4.png"),
    ]);
    for (const filePath of result.filePaths) {
      expect(fs.readFileSync(filePath).equals(pngBytes)).toBe(true);
    }
  });

  it("exports SVGs and reports nodes Figma could not render", async () => {
    const svg = `<svg width="24" height="24" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h24v24H0z"/></svg>`;
    renderBody = async () => svg;
    renderUrls = { "I5:6;7:8": `${RENDER_HOST}/icon.svg`, "10:11": null };

    const result = await run({ fileKey: "AbC123", nodeId: ["I5:6;7:8", "10:11"], format: "SVG" });

    expect(figmaApiRequests()[0].searchParams.get("format")).toBe("svg");
    expect(result.filePaths).toEqual([path.join(imageDir, "I5-6-7-8.svg")]);
    expect(fs.readFileSync(result.filePaths[0], "utf-8")).toBe(svg);
    expect(result.missingNodeIds).toEqual(["10:11"]);
  });

  it.each([
    [{ fileKey: "AbC123" }, "At least one node is required"],
    [{ nodeId: ["1:2"] }, "Either a Figma URL or --file-key is required"],
    [{ fileKey: "AbC123", nodeId: ["../1:2"] }, "Invalid node ID '../1:2'"],
    [{ fileKey: "AbC123", nodeId: ["1:2"], format: "jpg" }, "Invalid --format value 'jpg'"],
    [{ fileKey: "AbC123", nodeId: ["1:2"], scale: 0 }, "--scale must be a positive number"],
  ] satisfies Array<[DownloadImagesFlags, string]>)(
    "rejects invalid input before calling Figma: %j",
    async (flags, message) => {
      await expect(run(flags)).rejects.toThrow(message);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(fs.existsSync(imageDir)).toBe(false);
    },
  );
});
