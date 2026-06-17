import path from "path";
import os from "os";
import fs from "fs";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import jpeg from "@jimp/js-jpeg";
import * as crop from "@jimp/plugin-crop";

const Jimp = createJimp({ formats: [png, jpeg], plugins: [crop.methods] });
import {
  getImageDimensions,
  applyCropTransform,
  parseSvgDimensions,
} from "../utils/image-processing.js";
import type { Transform } from "@figma/rest-api-spec";

describe("image processing", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-processing-test-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  async function createTemp(name: string, width: number, height: number): Promise<string> {
    const filePath = path.join(tmpDir, name);
    const image = new Jimp({ width, height, color: 0xff0000ff });
    await image.write(filePath as `${string}.${string}`);
    return filePath;
  }

  describe("getImageDimensions", () => {
    it("reads correct dimensions from a PNG", async () => {
      const filePath = await createTemp("test-200x100.png", 200, 100);
      const dims = await getImageDimensions(filePath);
      expect(dims).toEqual({ width: 200, height: 100 });
    });

    it("reads correct dimensions from a JPEG", async () => {
      const filePath = await createTemp("test-300x150.jpg", 300, 150);
      const dims = await getImageDimensions(filePath);
      expect(dims).toEqual({ width: 300, height: 150 });
    });
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

  describe("applyCropTransform", () => {
    it("crops to the correct dimensions", async () => {
      const filePath = await createTemp("test-crop-400x400.png", 400, 400);

      // Crop to the top-left quarter: scale 0.5 in both axes, no translation
      const transform: Transform = [
        [0.5, 0, 0],
        [0, 0.5, 0],
      ];

      await applyCropTransform(filePath, transform);

      const dims = await getImageDimensions(filePath);
      expect(dims).toEqual({ width: 200, height: 200 });
    });

    it("returns original image unchanged for invalid crop dimensions", async () => {
      const filePath = await createTemp("test-crop-invalid.png", 100, 100);

      // Zero scale produces invalid (0-width) crop region
      const transform: Transform = [
        [0, 0, 0],
        [0, 0, 0],
      ];

      const result = await applyCropTransform(filePath, transform);
      expect(result).toBe(filePath);

      const dims = await getImageDimensions(filePath);
      expect(dims).toEqual({ width: 100, height: 100 });
    });
  });
});
