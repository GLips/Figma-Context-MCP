import path from "path";
import { describe, expect, it } from "vitest";
import { downloadFigmaImagesTool } from "~/mcp/tools/download-figma-images-tool.js";
import { downloadFigmaImage } from "~/utils/common.js";

const stubFigmaService = {} as Parameters<typeof downloadFigmaImagesTool.handler>[1];

const validParams = {
  fileKey: "abc123",
  nodes: [{ nodeId: "1:2", fileName: "test.png" }],
  pngScale: 2,
};

describe("download path validation", () => {
  const imageDir = "/project/root";

  it("rejects localPath that traverses outside imageDir", async () => {
    const result = await downloadFigmaImagesTool.handler(
      { ...validParams, localPath: "../../etc" },
      stubFigmaService,
      imageDir,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("resolves outside the allowed image directory");
    expect(result.content[0].text).toContain(imageDir);
  });

  it("rejects traversal with leading slash", async () => {
    const result = await downloadFigmaImagesTool.handler(
      { ...validParams, localPath: "/../../etc" },
      stubFigmaService,
      imageDir,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("resolves outside the allowed image directory");
  });

  it("accepts valid relative path within imageDir", async () => {
    // Will fail on the Figma API call — we only care that it doesn't
    // return the path validation error.
    const result = await downloadFigmaImagesTool.handler(
      { ...validParams, localPath: "public/images" },
      stubFigmaService,
      imageDir,
    );

    if (result.isError) {
      expect(result.content[0].text).not.toContain("resolves outside the allowed image directory");
    }
  });

  it("accepts path with leading slash as relative", async () => {
    // LLMs frequently produce paths like "/public/images" when they mean "public/images"
    const result = await downloadFigmaImagesTool.handler(
      { ...validParams, localPath: "/public/images" },
      stubFigmaService,
      imageDir,
    );

    if (result.isError) {
      expect(result.content[0].text).not.toContain("resolves outside the allowed image directory");
    }
  });
});

describe("downloadFigmaImage filename validation", () => {
  it("rejects fileName with directory traversal", async () => {
    const localPath = path.join(process.cwd(), "test-images");

    await expect(
      downloadFigmaImage("../../../etc/evil.png", localPath, "https://example.com/img.png"),
    ).rejects.toThrow("File path escapes target directory");
  });
});
