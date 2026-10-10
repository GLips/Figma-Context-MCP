import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import jpeg from "@jimp/js-jpeg";
import * as crop from "@jimp/plugin-crop";

const Jimp = createJimp({ formats: [png, jpeg], plugins: [crop.methods] });
import {
  downloadAndProcessImage,
  parseSvgDimensions,
  type ImageDestination,
} from "../utils/image-processing.js";
import type { Transform } from "@figma/rest-api-spec";

describe("image processing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function serveImage(
    mime: "image/png" | "image/jpeg",
    width: number,
    height: number,
  ): Promise<void> {
    const bytes = await new Jimp({ width, height, color: 0xff0000ff }).getBuffer(mime);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(bytes))),
    );
  }

  function memoryDestination(): ImageDestination & { written: Map<string, Buffer> } {
    const written = new Map<string, Buffer>();
    return {
      written,
      async write(fileName, bytes) {
        written.set(fileName, bytes);
        return `mem://${fileName}`;
      },
    };
  }

  it("measures a JPEG it doesn't crop", async () => {
    await serveImage("image/jpeg", 300, 150);
    const result = await downloadAndProcessImage(
      "photo.png",
      memoryDestination(),
      "https://cdn.example/photo",
      false,
      undefined,
      true,
    );
    expect(result.finalDimensions).toEqual({ width: 300, height: 150 });
    expect(result.cssVariables).toBe("--original-width: 300px; --original-height: 150px;");
    expect(result.location).toBe("mem://photo.png");
  });

  it("crops to the fill transform and stores the cropped bytes", async () => {
    await serveImage("image/png", 400, 400);
    const destination = memoryDestination();
    // Top-left quarter: scale 0.5 in both axes, no translation
    const transform: Transform = [
      [0.5, 0, 0],
      [0, 0.5, 0],
    ];
    const result = await downloadAndProcessImage(
      "fill.png",
      destination,
      "https://cdn.example/fill",
      true,
      transform,
    );
    expect(result.wasCropped).toBe(true);
    expect(result.finalDimensions).toEqual({ width: 200, height: 200 });
    const stored = await Jimp.fromBuffer(destination.written.get("fill.png")!);
    expect({ width: stored.width, height: stored.height }).toEqual({ width: 200, height: 200 });
  });

  it("keeps the original image when the transform leaves nothing visible", async () => {
    await serveImage("image/png", 100, 100);
    const result = await downloadAndProcessImage(
      "fill.png",
      memoryDestination(),
      "https://cdn.example/fill",
      true,
      [
        [0, 0, 0],
        [0, 0, 0],
      ],
    );
    expect(result.wasCropped).toBe(false);
    expect(result.finalDimensions).toEqual({ width: 100, height: 100 });
  });

  describe("parseSvgDimensions", () => {
    it("reads width/height attributes (Figma's typical export shape)", () => {
      const svg = `<svg width="52" height="52" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h52v52H0z"/></svg>`;
      expect(parseSvgDimensions(svg)).toEqual({ width: 52, height: 52 });
    });

    it("falls back to viewBox when width/height are percentages", () => {
      const svg = `<svg width="100%" height="100%" viewBox="0 0 24 16"><rect/></svg>`;
      expect(parseSvgDimensions(svg)).toEqual({ width: 24, height: 16 });
    });

    it("falls back to viewBox when width/height are absent", () => {
      const svg = `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg"></svg>`;
      expect(parseSvgDimensions(svg)).toEqual({ width: 120, height: 80 });
    });

    it("returns 0x0 when no usable size is declared", () => {
      expect(parseSvgDimensions(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)).toEqual({
        width: 0,
        height: 0,
      });
    });
  });
});
