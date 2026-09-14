import { it, expect } from "vitest";
import { simplify } from "@framelink/core";
import { sceneNodeToSnapshot } from "@framelink/plugin/node-to-snapshot";
import { restNodeToSnapshot } from "~/adapters/rest/node-to-snapshot.js";
import type { Node } from "@figma/rest-api-spec";

it("REST and plugin reads agree on wrapped gaps and nested exposure", async () => {
  const native = {
    id: "1:1",
    name: "Nested wrapping instance",
    type: "INSTANCE" as const,
    width: 200,
    height: 80,
    visible: true,
    clipsContent: false,
    layoutMode: "HORIZONTAL",
    layoutWrap: "WRAP",
    itemSpacing: 24,
    counterAxisSpacing: 12,
    counterAxisAlignContent: "AUTO",
    isExposedInstance: true,
    children: [],
    relativeTransform: [
      [1, 0, 0],
      [0, 1, 0],
    ],
    absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 80 },
  };
  const snapshots = [
    restNodeToSnapshot(native as unknown as Node),
    await sceneNodeToSnapshot(
      native as Parameters<typeof sceneNodeToSnapshot>[0],
      async () => null,
    ),
  ];
  for (const snapshot of snapshots) {
    const { nodes } = await simplify([snapshot]);
    expect(nodes[0].exposed).toBe(true);
    expect(nodes[0].layout).toMatchObject({ mode: "row", wrap: true, gap: "12px 24px" });
  }
});
