import yaml from "js-yaml";

/**
 * These options mirror the inline serialization in get-figma-data-tool.ts.
 * When that logic is extracted into a shared function, these tests will
 * switch to importing it — but the assertions stay the same.
 */
const yamlOptions: yaml.DumpOptions = {
  noRefs: true,
  lineWidth: -1,
  noCompatMode: true,
  schema: yaml.JSON_SCHEMA,
};

describe("result serialization", () => {
  describe("YAML format", () => {
    it("keeps long strings on a single line", () => {
      const longString = "a".repeat(200);
      const data = { description: longString };

      const output = yaml.dump(data, yamlOptions);
      const bare = yaml.dump(data);

      // Bare yaml.dump folds at 80 chars, producing multi-line output
      expect(bare.split("\n").length).toBeGreaterThan(2);
      // With lineWidth: -1, the value stays on one line (plus trailing newline)
      expect(output).toBe(`description: ${longString}\n`);
    });

    it("serializes duplicate references independently instead of using anchors", () => {
      const shared = { color: "#ff0000", opacity: 1 };
      const data = { fill: shared, stroke: shared };

      const output = yaml.dump(data, yamlOptions);
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

    it("round-trips through parse without data loss", () => {
      const data = {
        name: "Frame 1",
        width: 320,
        visible: true,
        children: [{ name: "Text", content: "hello" }],
      };

      const output = yaml.dump(data, yamlOptions);
      const parsed = yaml.load(output);

      expect(parsed).toEqual(data);
    });
  });

  describe("JSON format", () => {
    it("pretty-prints with 2-space indentation", () => {
      const data = { name: "Frame", width: 100 };

      const output = JSON.stringify(data, null, 2);

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

      const output = JSON.stringify(data, null, 2);
      const parsed = JSON.parse(output);

      expect(parsed).toEqual(data);
    });
  });
});
