import fs from "fs";
import os from "os";
import path from "path";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadFigmaImagesTool } from "~/mcp/tools/download-figma-images-tool.js";
import { FigmaService, staticCredentialSource } from "~/services/figma.js";
import type { ToolExtra } from "~/mcp/progress.js";

const Jimp = createJimp({ formats: [png] });

const FILE_KEY = "abc123";
const stubExtra = {
  sendNotification: () => Promise.resolve(),
  signal: AbortSignal.timeout(30_000),
} as unknown as ToolExtra;

/**
 * Figma's REST API and its S3 image host, stubbed at `fetch`. The fill resolves; the SVG render
 * resolves; the PNG render comes back null, as Figma does for a node it can't render.
 */
async function stubFigma(): Promise<void> {
  const pngBytes = await new Jimp({ width: 40, height: 20, color: 0xff0000ff }).getBuffer(
    "image/png",
  );
  const svgBytes = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="24"></svg>`;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === `/v1/files/${FILE_KEY}/images`) {
        return json({ meta: { images: { "ref-hero": "https://s3.test/hero" } } });
      }
      if (url.pathname === `/v1/images/${FILE_KEY}`) {
        return url.searchParams.get("format") === "svg"
          ? json({ images: { "1:2": "https://s3.test/icon" } })
          : json({ images: { "3:4": null } });
      }
      if (url.href === "https://s3.test/hero") return new Response(pngBytes);
      if (url.href === "https://s3.test/icon") return new Response(svgBytes);
      throw new Error(`unexpected fetch: ${url.href}`);
    }),
  );
}

describe("download_figma_images", () => {
  let imageDir: string;

  beforeEach(async () => {
    imageDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-images-test-"));
    await stubFigma();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(imageDir, { recursive: true });
  });

  it("attaches each file's aliases and outcome to that file, whatever order Figma resolves them in", async () => {
    const service = new FigmaService(
      staticCredentialSource({ figmaApiKey: "figd_test", figmaOAuthToken: "", useOAuth: false }),
    );

    // Render nodes and fills interleaved, so input order differs from fetch grouping.
    const result = await downloadFigmaImagesTool.handler(
      {
        fileKey: FILE_KEY,
        localPath: "out",
        pngScale: 2,
        nodes: [
          { nodeId: "1:2", fileName: "icon.svg" },
          { nodeId: "5:6", imageRef: "ref-hero", fileName: "hero.png" },
          { nodeId: "3:4", fileName: "unrenderable.png" },
          { nodeId: "7:8", imageRef: "ref-hero", fileName: "hero-2.png" },
        ],
      },
      service,
      { imageDir, extra: stubExtra, onComplete: vi.fn(), onReject: vi.fn() },
    );

    expect(result.isError).toBeUndefined();
    const lines = result.content[0].text.split("\n");
    expect(lines[0]).toContain("Downloaded 2 of 3 images");
    expect(lines.slice(1)).toEqual([
      "- icon.svg: 16x24",
      "- hero.png: 40x20 (also requested as: hero-2.png)",
      "- unrenderable.png: not downloaded, Figma returned no image for it",
    ]);
    expect(fs.readdirSync(path.join(imageDir, "out")).sort()).toEqual(["hero.png", "icon.svg"]);
  });
});
