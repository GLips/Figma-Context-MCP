import { expect, test } from "vitest";
import type { Node } from "@figma/rest-api-spec";
import { restNodeToSnapshot } from "~/adapters/rest/node-to-snapshot.js";
import { sceneNodeToSnapshot } from "@framelink/plugin/node-to-snapshot";
import { simplify } from "@framelink/core";

test("REST and plugin producers preserve all four bounds in canonical root and child geometry", async () => {
  const bounds = { minWidth: 160, maxWidth: 240, minHeight: 40, maxHeight: 80 };
  const child = {
    id: "1:2",
    name: "Bounded child",
    type: "RECTANGLE",
    width: 180,
    height: 60,
    x: 0,
    y: 0,
    absoluteBoundingBox: { x: 0, y: 0, width: 180, height: 60 },
    ...bounds,
  };
  const root = {
    id: "1:1",
    name: "Bounded root",
    type: "FRAME",
    layoutMode: "HORIZONTAL" as const,
    clipsContent: false,
    width: 200,
    height: 80,
    absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 80 },
    children: [child],
    ...bounds,
  };
  const snapshots = [
    restNodeToSnapshot(root as unknown as Node),
    await sceneNodeToSnapshot(root, async () => null),
  ];
  for (const snapshot of snapshots) {
    const result = await simplify([snapshot]);
    expect(result.nodes[0]).toMatchObject(bounds);
    expect(result.nodes[0].children![0]).toMatchObject(bounds);
  }
  const absent = await simplify([
    restNodeToSnapshot({
      ...root,
      children: [],
      minWidth: null,
      maxWidth: null,
      minHeight: null,
      maxHeight: null,
    } as unknown as Node),
  ]);
  for (const key of Object.keys(bounds)) expect(absent.nodes[0]).not.toHaveProperty(key);
});
