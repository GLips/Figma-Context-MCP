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
  expect(wire.nodes[0].elided).toEqual({ children: JSON.stringify(full.nodes[0].children).length });
  expect(JSON.stringify(full)).toBe(before);
  const leaf = projectReadNode(full.nodes[0].children![0], full);
  expect(leaf.type).toBe("IMAGE-SVG");
  expect(leaf.elided).toEqual({ d: JSON.stringify(path.vectorPaths![0].data).length });
  expect(projectNames(leaf).elided).toEqual(leaf.elided);
});

test("hidden roots and depth cuts have addresses; full reads have neither limit", async () => {
  const full = await simplify([
    { id: "hidden", name: "Hidden", type: "FRAME", visible: false, children: [path] },
  ]);
  expect(full.nodes[0].children).toHaveLength(1);
  const wire = project(full);
  expect(wire.nodes).toEqual([]);
  expect(wire.elided).toEqual([
    { id: "hidden", elided: { node: JSON.stringify(full.nodes[0]).length } },
  ]);
  const visible = await simplify([{ id: "root", name: "Root", type: "FRAME", children: [path] }]);
  expect(project(visible, { maxDepth: 0 }).nodes[0].elided).toEqual({
    children: JSON.stringify(visible.nodes[0].children).length,
  });
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
  expect(full.nodes[0].readOnlySource).toEqual(source);
  const wire = project(full);
  expect(wire.nodes[0].readOnlySource).toBeUndefined();
  expect(wire.nodes[0].elided).toEqual({ d: JSON.stringify(path.vectorPaths![0].data).length });
});

test("agent edits turn read objects into computed data, including edits within shared nested values", async () => {
  const full = await simplify([path]);
  full.nodes[0].d = "M0 0 L500 500";
  expect(project(full)).toBe(full);
  expect(projectReadNode(full.nodes[0], full)).toBe(full.nodes[0]);
  const nested = await simplify([path]);
  nested.nodes[0].readOnlySource!.vectorPaths![0].data = "M0 0 L1 1";
  expect(project(nested)).toBe(nested);
});

test("instance and definition children stay live in runtime; wire references retain their content in the component sidecar", async () => {
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
  expect(wire.nodes.every((node) => node.elided === undefined)).toBe(true);
  expect(wire.components.c.children).toHaveLength(1);
  expect(full.nodes[1].children?.[0].id).toBe("Ii;t");
});

test("donated component markers stay field-only and retain the donor address in childrenFrom", async () => {
  const full = await simplify([
    {
      id: "instance",
      name: "Instance",
      type: "INSTANCE",
      componentId: "missing",
      children: [
        { id: "Iinstance;text", name: "Title", type: "TEXT" },
        { ...path, id: "Iinstance;vector" },
      ],
    },
  ]);
  const wire = project(full);
  const donated = wire.components.missing.children!.find((node) => node.id === "vector")!;
  expect(donated.elided).toEqual({ d: JSON.stringify(path.vectorPaths![0].data).length });
  expect(wire.components.missing.childrenFrom).toBe("instance");
});

test("readOnlySource and child edges reconstruct the entire producer snapshot without losing fields", async () => {
  const source: NodeSnapshot = {
    id: "root",
    name: "Root",
    type: "FRAME",
    clipsContent: true,
    constraints: { horizontal: "MAX", vertical: "SCALE" },
    blendMode: "MULTIPLY",
    children: [path],
  };
  const full = await simplify([source]);
  const restore = (node: (typeof full.nodes)[number]): NodeSnapshot => ({
    ...node.readOnlySource!,
    ...(node.children ? { children: node.children.map(restore) } : {}),
  });
  expect(restore(full.nodes[0])).toEqual(source);
});

test("solid paint stacks flatten only in project", async () => {
  const full = await simplify([
    {
      id: "paint",
      name: "Paint",
      type: "RECTANGLE",
      fills: [
        { type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } },
        { type: "SOLID", color: { r: 0, g: 0, b: 1, a: 1 } },
      ],
    },
  ]);
  expect(full.nodes[0].fill).toEqual(["#0000FF", "#FF0000"]);
  const wire = project(full).nodes[0];
  expect(wire.fill).toBe("#0000FF");
  expect(wire.elided).toBeUndefined();
});

test("upstream depth omissions are marked with unknown size, not mistaken for empty containers", async () => {
  const full = await simplify([{ id: "page", name: "Page", type: "CANVAS" }]);
  const wire = project(full, { maxDepth: 1 });
  expect(wire.nodes[0].elided).toEqual({ children: null });
});

test("ordinary nodes, empty children and stripped names need no markers", async () => {
  const full = await simplify([{ id: "frame", name: "Frame 1", type: "FRAME", children: [] }]);
  const node = projectNames(project(full).nodes[0]);
  expect(node.elided).toBeUndefined();
  expect(node.name).toBeUndefined();
});
