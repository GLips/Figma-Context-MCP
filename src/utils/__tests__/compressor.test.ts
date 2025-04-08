import { SimplifiedNode, GlobalVars } from "~/services/simplify-node-response.js";
import { StyleId } from "~/utils/common.js";
import { flattenNodes, shortenGlobalVarIds } from "../compressor.js";

import yaml from "js-yaml";

// @ts-ignore
import testData from "./fixtures/figma_data.json" assert { type: "json" };

describe("compressor", () => {
  describe("shortenGlobalVarIds", () => {
    it("should shorten globalVar IDs correctly", () => {
      // Create a subset of the Figma data for testing
      const globalVars: GlobalVars = {
        styles: {
          layout_C71WG5: { mode: "none", sizing: {} },
          fill_PNVRKQ: [
            {
              type: "IMAGE",
              imageRef: "71327eae4d7fe3edf4f767464be4b5e7a87aff6c",
              scaleMode: "FILL",
            },
          ],
          style_WMXDFX: {
            fontFamily: "Urbanist",
            fontWeight: 400,
            fontSize: 24,
            lineHeight: "1.3333333333333333em",
            textAlignHorizontal: "LEFT",
            textAlignVertical: "CENTER",
          },
        } as Record<StyleId, any>,
      };

      const nodes: SimplifiedNode[] = [
        {
          id: "417:642",
          name: "Color",
          type: "RECTANGLE",
          fills: "fill_PNVRKQ" as StyleId,
          layout: "layout_C71WG5" as StyleId,
        },
        {
          id: "417:653",
          name: "Section title",
          type: "TEXT",
          textStyle: "style_WMXDFX" as StyleId,
          fills: "fill_PNVRKQ" as StyleId,
          layout: "layout_C71WG5" as StyleId,
          text: "Coffee Shop Mobile App",
        },
      ];

      const result = shortenGlobalVarIds(nodes, globalVars);

      // Check that all keys have been properly shortened
      expect(Object.keys(result.shortenedGlobalVars.styles).length).toBe(3);

      // Check if original IDs map to new shortened IDs
      expect(Object.keys(result.idMap).length).toBe(3);
      expect(Object.values(result.idMap).length).toBe(3);

      // Check that original prefixes were mapped correctly
      expect(result.prefixMap).toHaveProperty("l");
      expect(result.prefixMap).toHaveProperty("f");
      expect(result.prefixMap).toHaveProperty("s");

      // Check that original IDs starting with the same prefix got sequential numbers
      expect(result.idMap["layout_C71WG5" as StyleId]).toBe("l1");
      expect(result.idMap["fill_PNVRKQ" as StyleId]).toBe("f1");
      expect(result.idMap["style_WMXDFX" as StyleId]).toBe("s1");

      // Check that node references were updated
      const updatedNode1 = result.shortenedNodes[0];
      expect(updatedNode1.fills).toBe("f1");
      expect(updatedNode1.layout).toBe("l1");

      const updatedNode2 = result.shortenedNodes[1];
      expect(updatedNode2.fills).toBe("f1");
      expect(updatedNode2.layout).toBe("l1");
      expect(updatedNode2.textStyle).toBe("s1");
    });

    it("should handle multiple IDs with same prefix", () => {
      const globalVars: GlobalVars = {
        styles: {
          fill_123ABC: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
          fill_456DEF: [{ type: "SOLID", color: { r: 0, g: 1, b: 0 } }],
          fill_789GHI: [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }],
        } as Record<StyleId, any>,
      };

      const nodes: SimplifiedNode[] = [
        {
          id: "1:1",
          name: "Red",
          type: "RECTANGLE",
          fills: "fill_123ABC" as StyleId,
        },
        {
          id: "1:2",
          name: "Green",
          type: "RECTANGLE",
          fills: "fill_456DEF" as StyleId,
        },
        {
          id: "1:3",
          name: "Blue",
          type: "RECTANGLE",
          fills: "fill_789GHI" as StyleId,
        },
      ];

      const result = shortenGlobalVarIds(nodes, globalVars);

      // All should have the same prefix 'f' but different numbers
      expect(result.idMap["fill_123ABC" as StyleId]).toBe("f1");
      expect(result.idMap["fill_456DEF" as StyleId]).toBe("f2");
      expect(result.idMap["fill_789GHI" as StyleId]).toBe("f3");

      // Node references should be updated
      expect(result.shortenedNodes[0].fills).toBe("f1");
      expect(result.shortenedNodes[1].fills).toBe("f2");
      expect(result.shortenedNodes[2].fills).toBe("f3");
    });

    it("should handle similar prefixes with unique short prefixes", () => {
      // Test with prefixes that start with the same letter but are different
      const globalVars: GlobalVars = {
        styles: {
          fill_123: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
          frame_456: { mode: "none", sizing: {} },
          font_789: { fontFamily: "Arial", fontSize: 12 },
        } as Record<StyleId, any>,
      };

      const nodes: SimplifiedNode[] = [
        {
          id: "1:1",
          name: "Test",
          type: "RECTANGLE",
          fills: "fill_123" as StyleId,
        },
      ];

      const result = shortenGlobalVarIds(nodes, globalVars);

      // Should assign unique prefixes based on the first chars
      expect(result.idMap["fill_123" as StyleId]).toBe("f1");
      expect(result.idMap["frame_456" as StyleId]).toBe("fr1");
      expect(result.idMap["font_789" as StyleId]).toBe("fo1");

      // Prefix map should contain these unique prefixes
      expect(result.prefixMap["f"]).toBe("fill");
      expect(result.prefixMap["fr"]).toBe("frame");
      expect(result.prefixMap["fo"]).toBe("font");
    });

    it("should handle nested nodes with ID references", () => {
      const globalVars: GlobalVars = {
        styles: {
          layout_PARENT: { mode: "none", sizing: {} },
          layout_CHILD: { mode: "none", sizing: {} },
          fill_TEST: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
        } as Record<StyleId, any>,
      };

      const nodes: SimplifiedNode[] = [
        {
          id: "1:1",
          name: "Parent",
          type: "FRAME",
          layout: "layout_PARENT" as StyleId,
          children: [
            {
              id: "1:2",
              name: "Child",
              type: "RECTANGLE",
              layout: "layout_CHILD" as StyleId,
              fills: "fill_TEST" as StyleId,
            },
          ],
        },
      ];

      const result = shortenGlobalVarIds(nodes, globalVars);

      // Check parent node
      expect(result.shortenedNodes[0].layout).toBe("l1");

      // Check child node
      const childNode = result.shortenedNodes[0].children?.[0];
      expect(childNode).toBeDefined();
      if (childNode) {
        expect(childNode.layout).toBe("l2");
        expect(childNode.fills).toBe("f1");
      }
    });

    it("should handle real Figma data sample", () => {
      // Get a slice of real data from the fixture
      const sampleNodes = testData.nodes.slice(0, 5) as SimplifiedNode[];
      const sampleGlobalVars: GlobalVars = {
        styles: {} as Record<StyleId, any>,
      };

      // Copy a subset of styles to test with
      const styleKeys = Object.keys((testData.globalVars as any).styles).slice(0, 10);
      styleKeys.forEach((key) => {
        (sampleGlobalVars.styles as any)[key] = (testData.globalVars as any).styles[key];
      });

      const result = shortenGlobalVarIds(sampleNodes, sampleGlobalVars);

      // Basic validation checks
      expect(Object.keys(result.shortenedGlobalVars.styles).length).toBe(styleKeys.length);
      expect(Object.keys(result.idMap).length).toBe(styleKeys.length);

      // Check that all original IDs have a corresponding shortened ID
      styleKeys.forEach((originalId) => {
        expect(result.idMap).toHaveProperty(originalId);
        const shortId = result.idMap[originalId as StyleId];
        expect(result.shortenedGlobalVars.styles).toHaveProperty(shortId);
      });

      // Verify each shortened ID starts with the correct prefix
      styleKeys.forEach((originalId) => {
        const match = originalId.match(/^([a-zA-Z]+)_([a-zA-Z0-9]+)$/);
        if (match && match[1]) {
          const originalPrefix = match[1].toLowerCase();
          const shortId = result.idMap[originalId as StyleId];

          // Short ID should start with a prefix derived from the original prefix
          const shortPrefix = shortId.replace(/\d+$/, "");
          expect(
            originalPrefix.startsWith(shortPrefix) || shortPrefix + "_fallback" === originalPrefix,
          ).toBeTruthy();
        }
      });
    });
  });

  describe("flattenNodes", () => {
    it("should flatten nodes, remove children field and generate hierarchy string", () => {
      const nodes = [
        {
          id: "417:641",
          type: "FRAME",
          layout: "l1",
          children: [
            {
              id: "417:642",
              type: "RECTANGLE",
              fills: "f1",
            },
            {
              id: "417:646",
              type: "GROUP",
              layout: "l2",
              children: [
                {
                  id: "417:647",
                  type: "TEXT",
                  textStyle: "t1",
                },
              ],
            },
          ],
        },
      ];

      const result = flattenNodes(nodes);

      // Check hierarchy string
      expect(result.hierarchy).toBe("417:641(417:642,417:646(417:647))");

      // Check flattened nodes
      expect(result.nodes).toHaveLength(4);

      // Verify children field is removed and other properties are preserved
      expect(result.nodes[0]).toEqual({
        id: "417:641",
        type: "FRAME",
        layout: "l1",
      });

      expect(result.nodes[1]).toEqual({
        id: "417:642",
        type: "RECTANGLE",
        fills: "f1",
      });

      result.nodes.forEach((node) => {
        expect(node).not.toHaveProperty("children");
      });
    });

    it("should compare YAML size with real Figma data before and after flattening", () => {
      const nodes = testData.nodes;

      const yamlBeforeFlattening = yaml.dump(nodes);

      const result = flattenNodes(nodes);

      const yamlAfterFlattening = yaml.dump(result);

      const sizeDifference = yamlBeforeFlattening.length - yamlAfterFlattening.length;
      const percentageDifference = (sizeDifference / yamlBeforeFlattening.length) * 100;

      console.log(
        `REAL DATA - Size difference: ${sizeDifference} bytes (${percentageDifference.toFixed(2)}%)`,
      );

      expect(sizeDifference).not.toBe(0);
    });
  });
});
