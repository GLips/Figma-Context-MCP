import { expect, test } from "vitest";
import { simplify, project, projectReadNode, projectNames } from "../src/index.js";
import type { NodeSnapshot } from "../src/snapshot.js";

const path: NodeSnapshot = {
  id: "v",
  name: "Vector 1",
  type: "VECTOR",
  vectorPaths: [{ data: "M0 0 L8 0 L0 8 Z", windingRule: "NONZERO" }],
};

test("runtime retains SVG children, hidden nodes and producer detail; projection copies and marks cuts", async () => {
  const source: NodeSnapshot = {
    id: "frame",
    name: "Icon",
    type: "FRAME",
    children: [path, { id: "hidden", name: "Hidden", type: "RECTANGLE", visible: false }],
  };
  const full = await simplify([source]);
  const before = JSON.stringify(full);
  expect(full.nodes[0].children?.map((node) => node.id)).toEqual(["v", "hidden"]);
  expect(full.nodes[0].children?.[0].type).toBe("VECTOR");
  expect(full.nodes[0].children?.[0].d).toBe(path.vectorPaths![0].data);
  expect(full.nodes[0].children?.[1].visible).toBe(false);
  const wire = project(full);
  expect(wire.nodes[0].type).toBe("IMAGE-SVG");
  expect(wire.nodes[0].children).toBeUndefined();
  const marker = wire.nodes[0].elided?.find((entry) => entry.$elided.field === "children")?.$elided;
  expect(marker).toEqual({
    id: "frame",
    field: "children",
    chars: JSON.stringify(full.nodes[0].children).length,
    read: 'flcm.get("frame")',
  });
  expect(JSON.stringify(full)).toBe(before);
  const leaf = projectReadNode(full.nodes[0].children![0], full);
  expect(leaf.type).toBe("IMAGE-SVG");
  expect(leaf.elided?.some((entry) => entry.$elided.field === "d")).toBe(true);
  expect(projectNames(leaf).elided?.some((entry) => entry.$elided.field === "name")).toBe(true);
});

test("hidden roots and depth cuts have addresses; full reads have neither limit", async () => {
  const full = await simplify([
    { id: "hidden", name: "Hidden", type: "FRAME", visible: false, children: [path] },
  ]);
  expect(full.nodes[0].children).toHaveLength(1);
  const wire = project(full);
  expect(wire.nodes).toEqual([]);
  expect(wire.elided?.[0].$elided.id).toBe("hidden");
  const visible = await simplify([{ id: "root", name: "Root", type: "FRAME", children: [path] }]);
  expect(
    project(visible, { maxDepth: 0 }).nodes[0].elided?.some(
      (entry) => entry.$elided.field === "children",
    ),
  ).toBe(true);
});

test("disabled paint/effect stacks, exact geometry and named-style identities remain inspectable", async () => {
  const source: NodeSnapshot = {
    ...path,
    ownSize: { width: 8.1234567, height: 9.8765432 },
    fills: [{ type: "SOLID", visible: false, color: { r: 1, g: 0, b: 0, a: 1 } }],
    effects: [{ type: "LAYER_BLUR", radius: 8, visible: false }],
    styles: { fill: { id: "style", name: "Accent" } },
  };
  const full = await simplify([source]);
  expect(full.nodes[0].details).toEqual(source);
  const wire = project(full);
  expect(wire.nodes[0].details).toBeUndefined();
  expect(
    wire.nodes[0].elided?.find((entry) => entry.$elided.field === "details")?.$elided.chars,
  ).toBe(JSON.stringify(source).length);
});

test("agent edits turn read objects into computed data, including edits within shared nested values", async () => {
  const full = await simplify([path]);
  full.nodes[0].d = "M0 0 L500 500";
  expect(project(full)).toBe(full);
  expect(projectReadNode(full.nodes[0], full)).toBe(full.nodes[0]);
  const nested = await simplify([path]);
  nested.nodes[0].details!.vectorPaths![0].data = "M0 0 L1 1";
  expect(project(nested)).toBe(nested);
});

test("instance and definition children stay live in runtime; wire diffs carry elisions", async () => {
  const full = await simplify([
    {
      id: "c",
      name: "Component",
      type: "COMPONENT",
      children: [{ id: "t", name: "Title", type: "TEXT" }],
    },
    {
      id: "i",
      name: "Instance",
      type: "INSTANCE",
      componentId: "c",
      children: [{ id: "Ii;t", name: "Title", type: "TEXT" }],
    },
  ]);
  expect(full.nodes.map((node) => node.children?.[0].id)).toEqual(["t", "Ii;t"]);
  const wire = project(full);
  expect(wire.nodes.every((node) => !node.children)).toBe(true);
  expect(
    wire.nodes.every((node) => node.elided?.some((entry) => entry.$elided.field === "children")),
  ).toBe(true);
  expect(full.nodes[1].children?.[0].id).toBe("Ii;t");
});
