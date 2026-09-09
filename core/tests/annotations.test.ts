import { expect, test } from "vitest";
import { simplify } from "../src/simplify.js";

test("annotations pass through with text, category name and pins; an empty collection is absent", async () => {
  const annotations = [
    { text: "Make this primary", category: "Agent" },
    { text: "Opens filters", properties: ["width", "fills"] },
    { properties: ["height"] },
  ];
  const { nodes } = await simplify([
    { id: "1", name: "Instructions", type: "RECTANGLE", annotations },
    { id: "2", name: "Empty", type: "RECTANGLE", annotations: [] },
    { id: "3", name: "Absent", type: "RECTANGLE" },
  ]);
  expect(nodes[0].annotations).toEqual(annotations);
  expect("annotations" in nodes[1]).toBe(false);
  expect("annotations" in nodes[2]).toBe(false);
});
