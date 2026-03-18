import path from "path";
import fs from "fs";
import { Jimp } from "jimp";
import { getImageDimensions, applyCropTransform } from "../utils/image-processing.js";
import type { Transform } from "@figma/rest-api-spec";

const FIXTURES_DIR = path.resolve(__dirname, "../../tests/fixtures");

async function createTestImage(
  name: string,
  width: number,
  height: number,
  color: number = 0xff0000ff,
): Promise<string> {
  const filePath = path.join(FIXTURES_DIR, name);
  const image = new Jimp({ width, height, color });
  await image.write(filePath as `${string}.${string}`);
  return filePath;
}

describe("image processing", () => {
  const tempFiles: string[] = [];

  async function createTemp(name: string, width: number, height: number): Promise<string> {
    const filePath = await createTestImage(name, width, height);
    tempFiles.push(filePath);
    return filePath;
  }

  afterAll(() => {
    for (const f of tempFiles) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

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
