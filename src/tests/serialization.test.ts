import yaml from "js-yaml";
import { serializeResult } from "~/utils/serialize.js";
import { wrapForSerialization } from "~/utils/serializable-design.js";
import type { SimplifiedDesign } from "~/extractors/types.js";

describe("result serialization", () => {
  describe("YAML format", () => {
    it("keeps long strings on a single line", () => {
      const longString = "a".repeat(200);
      const data = { description: longString };

      const output = serializeResult(data, "yaml");
      const bare = yaml.dump(data);

      // Bare yaml.dump folds at 80 chars, producing multi-line output
      expect(bare.split("\n").length).toBeGreaterThan(2);
      // With lineWidth: -1, the value stays on one line (plus trailing newline)
      expect(output).toBe(`description: ${longString}\n`);
    });

    it("serializes duplicate references independently instead of using anchors", () => {
      const shared = { color: "#ff0000", opacity: 1 };
      const data = { fill: shared, stroke: shared };

      const output = serializeResult(data, "yaml");
      const bare = yaml.dump(data);

      // Bare yaml.dump detects the shared reference and emits anchors/aliases
      expect(bare).toMatch(/&ref_0/);
      expect(bare).toMatch(/\*ref_0/);

      // With noRefs: true, each occurrence is serialized independently
      expect(output).not.toMatch(/&ref/);
      expect(output).not.toMatch(/\*ref/);
      // Both occurrences appear fully expanded
      const colorMatches = output.match(/color: '#ff0000'/g);
      expect(colorMatches).toHaveLength(2);
    });

    it("skips unnecessary quoting for strings ambiguous under default YAML schema", () => {
      const data = { answer: "yes", date: "2024-01-01" };

      const output = serializeResult(data, "yaml");
      const bare = yaml.dump(data);

      // Default schema quotes "yes" and "2024-01-01" to prevent
      // boolean/timestamp interpretation on load.
      expect(bare).toContain("'yes'");
      expect(bare).toContain("'2024-01-01'");

      // JSON_SCHEMA only recognizes true/false as booleans and has no
      // timestamp type, so these strings don't need protective quoting.
      expect(output).not.toContain("'yes'");
      expect(output).not.toContain("'2024-01-01'");
    });

    it("round-trips through parse without data loss", () => {
      const data = {
        name: "Frame 1",
        width: 320,
        visible: true,
        children: [{ name: "Text", content: "hello" }],
      };

      const output = serializeResult(data, "yaml");
      const parsed = yaml.load(output);

      expect(parsed).toEqual(data);
    });
  });

  describe("JSON format", () => {
    it("pretty-prints with 2-space indentation", () => {
      const data = { name: "Frame", width: 100 };

      const output = serializeResult(data, "json");

      const lines = output.split("\n");
      // Second line should be indented with exactly 2 spaces
      expect(lines[1]).toMatch(/^ {2}"/);
    });

    it("round-trips through parse without data loss", () => {
      const data = {
        name: "Frame 1",
        width: 320,
        visible: true,
        children: [{ name: "Text", content: "hello" }],
      };

      const output = serializeResult(data, "json");
      const parsed = JSON.parse(output);

      expect(parsed).toEqual(data);
    });
  });

  describe("tree format", () => {
    // The production pipeline wraps the SimplifiedDesign before calling
    // serializeResult. The tree renderer must read from that wrapped shape;
    // a regression here silently broke the production --format=tree path.
    it("renders the wrapped design shape produced by getFigmaData", () => {
      const design: SimplifiedDesign = {
        name: "Test File",
        components: {},
        componentSets: {},
        globalVars: { styles: {} },
        elements: {},
        nodes: [
          {
            id: "1:1",
            name: "Card",
            type: "FRAME",
            borderRadius: "12px",
          },
        ],
      };

      const output = serializeResult(wrapForSerialization(design), "tree");

      expect(output).toContain('NAME: "Test File"');
      expect(output).toContain("NODES:");
      expect(output).toMatch(/\[FRAME\] "Card" #1:1 borderRadius=12px/);
    });

    // Figma allows free-form component property names like "On Sale". The
    // value must serialize as readable JSON — earlier attempts escaped
    // whitespace to \uXXXX, which is hostile to the LLM consumer.
    it("emits componentProperties as readable JSON even when keys contain whitespace", () => {
      const design: SimplifiedDesign = {
        name: "Test",
        components: {},
        componentSets: {},
        globalVars: { styles: {} },
        elements: {},
        nodes: [
          {
            id: "1:1",
            name: "Btn",
            type: "INSTANCE",
            componentId: "abc",
            componentProperties: { "On Sale": true, Size: "md" },
          },
        ],
      };

      const output = serializeResult(wrapForSerialization(design), "tree");

      expect(output).toContain('componentProperties={"On Sale":true,"Size":"md"}');
    });

    // After count-gating, single-use style values live inline on the node rather
    // than as a globalVars ref. The tree renderer must emit them as compact JSON.
    it("renders inline (non-reference) style values as JSON", () => {
      const design: SimplifiedDesign = {
        name: "Test",
        components: {},
        componentSets: {},
        globalVars: { styles: {} },
        elements: {},
        nodes: [
          {
            id: "1:1",
            name: "Box",
            type: "FRAME",
            fills: ["#FF0000"],
          },
        ],
      };

      const output = serializeResult(wrapForSerialization(design), "tree");

      expect(output).toContain('fills=["#FF0000"]');
    });

    // Deduplicated nodes carry only id/name/template/children; the type and
    // styling live in the ELEMENTS block. The renderer resolves the type label
    // from the element so the line keeps its `[TYPE] "name" #id` shape.
    it("renders an ELEMENTS block and template-reference nodes", () => {
      const design: SimplifiedDesign = {
        name: "Test",
        components: {},
        componentSets: {},
        globalVars: { styles: { fill_red: ["#FF0000"] } },
        elements: {
          "EL-abc12345": { type: "FRAME", fills: "fill_red" },
        },
        nodes: [
          { id: "1:1", name: "Card A", template: "EL-abc12345" },
          { id: "1:2", name: "Card B", template: "EL-abc12345" },
        ],
      };

      const output = serializeResult(wrapForSerialization(design), "tree");

      expect(output).toContain("ELEMENTS:");
      expect(output).toContain('[FRAME] "Card A" #1:1 template=EL-abc12345');
      expect(output).toContain('[FRAME] "Card B" #1:2 template=EL-abc12345');
    });
  });
});
