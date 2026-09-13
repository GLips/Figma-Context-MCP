import { describe, expect, it } from "vitest";
import { parseFigmaUrl } from "~/utils/figma-url.js";

const KEY = "aBc123XyZ";

describe("parseFigmaUrl", () => {
  it.each(["design", "file", "proto"])("accepts /%s/ links", (segment) => {
    expect(parseFigmaUrl(`https://www.figma.com/${segment}/${KEY}/Some-Slug`)).toEqual({
      fileKey: KEY,
      nodeId: undefined,
    });
  });

  it("converts the URL's dashed node-id to the API's colon form", () => {
    expect(parseFigmaUrl(`https://www.figma.com/design/${KEY}/Slug?node-id=1234-5678`)).toEqual({
      fileKey: KEY,
      nodeId: "1234:5678",
    });
  });

  it("rejects FigJam boards, whose node vocabulary this server does not model", () => {
    expect(() => parseFigmaUrl(`https://www.figma.com/board/${KEY}/Slug`)).toThrow(
      /Could not extract file key/,
    );
  });

  it("rejects non-Figma hosts", () => {
    expect(() => parseFigmaUrl(`https://figma.com.evil.test/design/${KEY}/Slug`)).toThrow(
      /Not a Figma URL/,
    );
  });
});
