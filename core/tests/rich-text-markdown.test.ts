import { expect, test } from "vitest";
import { simplify, project } from "../src/index.js";
import type { NodeSnapshot } from "../src/snapshot.js";

test("a whitespace-only bold run between emphasized words emits no empty markers", async () => {
  const base = { fontFamily: "Inter", fontWeight: 400, fontSize: 16 };
  const node: NodeSnapshot = {
    id: "t",
    name: "Label",
    type: "TEXT",
    text: {
      characters: "A B",
      style: base,
      lines: [
        [
          { text: "A", delta: { fontWeight: 700, italic: true } },
          { text: " ", delta: { fontWeight: 700 } },
          { text: "B", delta: { italic: true } },
        ],
      ],
      lineTypes: ["NONE"],
      lineIndentations: [0],
    },
  };
  const wire = project(await simplify([node]));
  expect(wire.nodes[0].text).toBe("***A*** *B*");
});
