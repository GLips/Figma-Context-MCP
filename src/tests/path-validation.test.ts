import path from "path";
import { describe, expect, it } from "vitest";
import { downloadFigmaImagesTool } from "~/mcp/tools/download-figma-images-tool.js";
import { downloadFigmaImage } from "~/utils/common.js";

const stubFigmaService = {
  downloadImages: () => Promise.resolve([]),
} as unknown as Parameters<typeof downloadFigmaImagesTool.handler>[1];

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
    const result = await downloadFigmaImagesTool.handler(
      { ...validParams, localPath: "public/images" },
      stubFigmaService,
      imageDir,
    );

    expect(result.isError).toBeUndefined();
  });

  it("accepts valid path when imageDir is a drive root", async () => {
    // Windows drive roots (E:\, D:\) already end with a separator.
    // path.resolve on posix treats this as a regular directory, which is fine
    // — the logic under test is the prefix check, not actual Windows I/O.
    const driveRoot = path.resolve("/");
    const result = await downloadFigmaImagesTool.handler(
      { ...validParams, localPath: "project/src/static/images/test" },
      stubFigmaService,
      driveRoot,
    );

    expect(result.isError).toBeUndefined();
  });

  it("accepts path with leading slash as relative", async () => {
    const result = await downloadFigmaImagesTool.handler(
      { ...validParams, localPath: "/public/images" },
      stubFigmaService,
      imageDir,
    );

    expect(result.isError).toBeUndefined();
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
