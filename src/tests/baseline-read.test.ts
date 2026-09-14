import { it, expect } from "vitest";
import { simplify } from "@framelink/core";
import { sceneNodeToSnapshot } from "@framelink/plugin/node-to-snapshot";
import { restNodeToSnapshot } from "~/adapters/rest/node-to-snapshot.js";
import type { Node } from "@figma/rest-api-spec";

it("REST and plugin adapters preserve native baseline through simplification", async () => {
  const common = {
    id: "1:1",
    name: "Baseline row",
    type: "FRAME" as const,
    width: 100,
    height: 40,
    visible: true,
    clipsContent: false,
    layoutMode: "HORIZONTAL",
    counterAxisAlignItems: "BASELINE",
    primaryAxisAlignItems: "MIN",
    children: [],
    relativeTransform: [
      [1, 0, 0],
      [0, 1, 0],
    ],
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
  };
  const rest = restNodeToSnapshot(common as unknown as Node);
  const plugin = await sceneNodeToSnapshot(
    common as Parameters<typeof sceneNodeToSnapshot>[0],
    async () => null,
  );
  expect(rest.counterAxisAlignItems).toBe("BASELINE");
  expect(plugin.counterAxisAlignItems).toBe("BASELINE");
  for (const snapshot of [rest, plugin]) {
    const result = await simplify([snapshot]);
    const layout = result.nodes[0].layout;
    expect(layout && typeof layout === "object" ? layout.alignItems : layout).toBe("baseline");
  }
});
