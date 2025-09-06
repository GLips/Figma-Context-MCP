/* eslint-env jest */
import { config } from "dotenv";
import yaml from "js-yaml";
import { getFigmaData, FigmaService } from "../index.js";

config();

describe("Figma tool functions", () => {
  const figmaApiKey = process.env.FIGMA_API_KEY || "";
  const figmaFileKey = process.env.FIGMA_FILE_KEY || "";

  if (!figmaApiKey || !figmaFileKey) {
    it.skip("requires Figma credentials", () => {});
    return;
  }

  const figmaService = new FigmaService({
    figmaApiKey,
    figmaOAuthToken: "",
    useOAuth: false,
  });

  it(
    "should be able to get Figma file data",
    async () => {
      const result = await getFigmaData({ fileKey: figmaFileKey }, figmaService, "yaml");
      const content = result.content[0].text as string;
      const parsed = yaml.load(content);
      expect(parsed).toBeDefined();
    },
    60000,
  );
});
