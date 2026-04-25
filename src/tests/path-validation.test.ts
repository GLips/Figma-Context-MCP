import path from "path";
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
import { resolveLocalPath, isWithin } from "~/utils/local-path.js";
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

describe("download path validation (handler)", () => {
  const imageDir = path.resolve("/project/root");

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

    expect(result.isError).toBe(true);

    const captureSpy = vi.mocked(telemetry.captureValidationReject);
    expect(captureSpy).toHaveBeenCalledOnce();
    const [input, context] = captureSpy.mock.calls[0];
    expect(input.tool).toBe("download_figma_images");
    expect(input.field).toBe("localPath");
    expect(input.rule).toBe("outside_image_dir");
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

  it("hints at the relative form when a leading slash takes the path outside imageDir", async () => {
    const result = await downloadFigmaImagesTool.handler(
      { ...validParams, localPath: "/some/elsewhere" },
      stubFigmaService,
      imageDir,
      "stdio",
      "api_key",
      undefined,
      stubExtra,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("drop the leading slash");
    expect(result.content[0].text).toContain('"some/elsewhere"');
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
    // Drive roots already end with a separator. The unified containment check
    // uses path.relative, so the trailing separator no longer causes false
    // rejection (the previous startsWith(base + sep) check did).
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
});

describe("resolveLocalPath", () => {
  describe("with POSIX semantics (path.posix)", () => {
    const base = "/project/root";
    const posix = path.posix;

    it("resolves a relative path under base", () => {
      const result = resolveLocalPath("public/images", base, posix);
      expect(result).toEqual({ ok: true, resolvedPath: "/project/root/public/images" });
    });

    it("rejects a relative path that traverses out", () => {
      const result = resolveLocalPath("../etc", base, posix);
      expect(result).toEqual({ ok: false, reason: "outside_image_dir" });
    });

    it("accepts an absolute path inside base", () => {
      const inside = "/project/root/public/images";
      const result = resolveLocalPath(inside, base, posix);
      expect(result).toEqual({ ok: true, resolvedPath: inside });
    });

    it("rejects an absolute path outside base", () => {
      const result = resolveLocalPath("/some/other/place", base, posix);
      expect(result).toEqual({ ok: false, reason: "outside_image_dir" });
    });

    it("rejects a leading-slash path that would have doubled under the legacy join hack", () => {
      // Used to be silently accepted as "<base>/Users/xl/Desktop/figma/public/images".
      const result = resolveLocalPath("/Users/xl/Desktop/figma/public/images", base, posix);
      expect(result).toEqual({ ok: false, reason: "outside_image_dir" });
    });

    it("rejects backslash drive-letter paths on POSIX", () => {
      const result = resolveLocalPath("C:\\Users\\xl\\Desktop\\figma\\public", base, posix);
      expect(result).toEqual({ ok: false, reason: "drive_letter_on_posix" });
    });

    it("rejects forward-slash drive-letter paths on POSIX", () => {
      // path.posix.isAbsolute("C:/Users/...") returns false, so without an
      // explicit check this would resolve to "<base>/C:/Users/..." and miswrite.
      const result = resolveLocalPath("C:/Users/xl/Desktop/figma/public", base, posix);
      expect(result).toEqual({ ok: false, reason: "drive_letter_on_posix" });
    });

    it("normalizes backslashes in relative paths to forward slashes on POSIX", () => {
      // LLMs frequently send Windows-style separators regardless of host OS.
      // Drive-letter paths still reject (above) — only pure separator
      // mismatches normalize.
      const result = resolveLocalPath("local\\nested\\dir", base, posix);
      expect(result).toEqual({ ok: true, resolvedPath: "/project/root/local/nested/dir" });
    });
  });

  describe("with Windows semantics (path.win32)", () => {
    const base = "C:\\Users\\xl\\Desktop\\figma";
    const win32 = path.win32;

    it("accepts an absolute Windows path inside base", () => {
      const inside = "C:\\Users\\xl\\Desktop\\figma\\public\\figma-assets\\retry-final";
      const result = resolveLocalPath(inside, base, win32);
      expect(result).toEqual({ ok: true, resolvedPath: inside });
    });

    it("rejects an absolute Windows path on a different drive", () => {
      const result = resolveLocalPath("D:\\elsewhere\\images", base, win32);
      expect(result).toEqual({ ok: false, reason: "outside_image_dir" });
    });

    // Note on the "LLM stripped the drive letter" scenario from issue #364:
    // path.win32.resolve("/Users/...") drive-roots the path on the runtime's
    // *current* Windows drive, which doesn't exist on POSIX hosts running
    // path.win32. So that specific scenario can't be deterministically
    // unit-tested without a Windows runner. The drive-letter-inside-base
    // test below covers the primary issue #364 input shape.

    it("accepts a relative path under base", () => {
      const result = resolveLocalPath("public\\images", base, win32);
      expect(result).toEqual({
        ok: true,
        resolvedPath: "C:\\Users\\xl\\Desktop\\figma\\public\\images",
      });
    });

    it("normalizes forward slashes from the LLM into Windows separators", () => {
      // LLMs frequently emit forward slashes regardless of host OS.
      // path.win32.resolve normalizes them — verify the joined path is
      // backslash-canonical and lands inside base.
      const result = resolveLocalPath("public/images/icons", base, win32);
      expect(result).toEqual({
        ok: true,
        resolvedPath: "C:\\Users\\xl\\Desktop\\figma\\public\\images\\icons",
      });
    });

    it("rejects '..' traversal", () => {
      const result = resolveLocalPath("..\\..\\Windows\\System32", base, win32);
      expect(result).toEqual({ ok: false, reason: "outside_image_dir" });
    });

    it("does not apply the POSIX backslash rule", () => {
      // On Windows backslashes are valid separators, so this is just a
      // relative path (assuming it's within base).
      const result = resolveLocalPath("public\\nested\\images", base, win32);
      expect(result.ok).toBe(true);
    });
  });

  describe("isWithin (containment helper)", () => {
    it("treats base itself as within", () => {
      expect(isWithin("/project/root", "/project/root", path.posix)).toBe(true);
    });

    it("accepts descendants", () => {
      expect(isWithin("/project/root", "/project/root/public/images", path.posix)).toBe(true);
    });

    it("rejects siblings", () => {
      expect(isWithin("/project/root", "/project/sibling", path.posix)).toBe(false);
    });

    it("rejects ancestors", () => {
      expect(isWithin("/project/root", "/project", path.posix)).toBe(false);
    });

    it("works for Windows drive roots without double-counting separators", () => {
      // The previous startsWith(base + sep) check would reject this because
      // "C:\\" + "\\" produces "C:\\\\" which doesn't prefix "C:\\public".
      expect(isWithin("C:\\", "C:\\public\\images", path.win32)).toBe(true);
    });
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
