import path from "path";
import fs from "fs";
import os from "os";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("~/telemetry/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/telemetry/index.js")>();
  return {
    ...actual,
    captureValidationReject: vi.fn(),
  };
});

import { downloadFigmaImagesTool } from "~/mcp/tools/download-figma-images-tool.js";
import { downloadFigmaImage } from "~/utils/common.js";
import type { ToolExtra } from "~/mcp/progress.js";
import * as telemetry from "~/telemetry/index.js";

const stubFigmaService = {
  downloadImages: () => Promise.resolve([]),
} as unknown as Parameters<typeof downloadFigmaImagesTool.handler>[1];

const stubExtra = {
  sendNotification: () => Promise.resolve(),
  signal: AbortSignal.timeout(30_000),
} as unknown as ToolExtra;

const validParams = {
  fileKey: "abc123",
  nodes: [{ nodeId: "1:2", fileName: "test.png" }],
  pngScale: 2,
};

describe("download path validation", () => {
  const imageDir = "/project/root";

  beforeEach(() => {
    vi.mocked(telemetry.captureValidationReject).mockClear();
  });

  it("captures path-traversal attempts as validation rejects", async () => {
    const result = await downloadFigmaImagesTool.handler(
      { ...validParams, localPath: "../../etc" },
      stubFigmaService,
      imageDir,
      "stdio",
      "api_key",
      undefined,
      stubExtra,
    );

    // The handler still returns the existing user-facing error
    expect(result.isError).toBe(true);

    // And the rejection is recorded with structured field/rule
    const captureSpy = vi.mocked(telemetry.captureValidationReject);
    expect(captureSpy).toHaveBeenCalledOnce();
    const [input, context] = captureSpy.mock.calls[0];
    expect(input.tool).toBe("download_figma_images");
    expect(input.field).toBe("localPath");
    expect(input.rule).toBe("path_traversal");
    expect(context.transport).toBe("stdio");
    expect(context.authMode).toBe("api_key");
  });

  it("rejects localPath that traverses outside imageDir", async () => {
    const result = await downloadFigmaImagesTool.handler(
      { ...validParams, localPath: "../../etc" },
      stubFigmaService,
      imageDir,
      "stdio",
      "api_key",
      undefined,
      stubExtra,
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
      "stdio",
      "api_key",
      undefined,
      stubExtra,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("resolves outside the allowed image directory");
  });

  it("accepts valid relative path within imageDir", async () => {
    const result = await downloadFigmaImagesTool.handler(
      { ...validParams, localPath: "public/images" },
      stubFigmaService,
      imageDir,
      "stdio",
      "api_key",
      undefined,
      stubExtra,
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
      "stdio",
      "api_key",
      undefined,
      stubExtra,
    );

    expect(result.isError).toBeUndefined();
  });

  it("accepts path with leading slash as relative", async () => {
    const result = await downloadFigmaImagesTool.handler(
      { ...validParams, localPath: "/public/images" },
      stubFigmaService,
      imageDir,
      "stdio",
      "api_key",
      undefined,
      stubExtra,
    );

    expect(result.isError).toBeUndefined();
  });

  it("accepts a non-existent nested path whose existing prefix stays within imageDir", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "path-validation-base-"));

    const result = await downloadFigmaImagesTool.handler(
      { ...validParams, localPath: "nested/assets/icons" },
      stubFigmaService,
      base,
      "stdio",
      "api_key",
      undefined,
      stubExtra,
    );

    expect(result.isError).toBeUndefined();

    fs.rmSync(base, { recursive: true, force: true });
  });

  it("rejects localPath when a symlinked segment escapes imageDir", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "path-validation-base-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "path-validation-outside-"));
    fs.symlinkSync(outside, path.join(base, "linked"), "dir");

    const result = await downloadFigmaImagesTool.handler(
      { ...validParams, localPath: "linked" },
      stubFigmaService,
      base,
      "stdio",
      "api_key",
      undefined,
      stubExtra,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("resolves outside the allowed image directory");

    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("rejects localPath when an intermediate symlinked segment escapes imageDir", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "path-validation-base-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "path-validation-outside-"));
    fs.mkdirSync(path.join(base, "nested"), { recursive: true });
    fs.symlinkSync(outside, path.join(base, "nested", "linked"), "dir");

    const result = await downloadFigmaImagesTool.handler(
      { ...validParams, localPath: "nested/linked/assets" },
      stubFigmaService,
      base,
      "stdio",
      "api_key",
      undefined,
      stubExtra,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("resolves outside the allowed image directory");

    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
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
