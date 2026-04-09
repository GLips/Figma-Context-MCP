import yaml from "js-yaml";
import { serializeResult } from "~/utils/serialize.js";

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
});
