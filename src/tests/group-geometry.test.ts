import { describe, expect, it } from "vitest";
import { sceneNodeToSnapshot } from "@framelink/plugin/node-to-snapshot";
import { restResponseToSnapshots } from "~/adapters/rest/rest.js";
import { simplify } from "@framelink/core";
import type { SimplifiedNode } from "@framelink/core";
import { GOLDEN_FIXTURES } from "./goldens/fixtures.js";
import { loadScene } from "./parity/scenes-io.js";

// Reconstruct the rendered corners, as a consumer nesting CSS transforms with
// transform-origin: 0 0 would. Comparing page-space bounds catches a shared
// producer error that output parity alone cannot detect.
function transform(node: SimplifiedNode, [x, y]: number[]): number[] {
  const radians = ((node.rotation ?? 0) * Math.PI) / 180;
  return [
    (node.left ?? 0) + x * Math.cos(radians) - y * Math.sin(radians),
    (node.top ?? 0) + x * Math.sin(radians) + y * Math.cos(radians),
  ];
}

for (const producer of ["rest", "plugin"] as const) {
  describe(`${producer} group geometry`, () => {
    it("composes child transforms into the authored page-space bounds", async () => {
      const fixture = GOLDEN_FIXTURES.find((entry) => entry.name === "grouped-nodes")!;
      const scene = loadScene("grouped-nodes")!;
      const snapshots =
        producer === "rest"
          ? restResponseToSnapshots(fixture.response).snapshots
          : await Promise.all(
              scene.roots.map((root) => sceneNodeToSnapshot(root, scene.resolveStyle)),
            );
      const { nodes } = await simplify(snapshots);
      const group = nodes[0].children!.find((node) => node.id === "8:8")!;
      const expected = [
        { rotation: 0, x: 250, y: 44.6429, width: 71.2832, height: 61.6094 },
        { rotation: -15, x: 215, y: 78.577, width: 74.1393, height: 66.7439 },
      ];
      for (const [index, child] of group.children!.entries()) {
        const target = expected[index];
        expect(child.rotation ?? 0).toBe(target.rotation);
        expect(typeof child.width).toBe("number");
        expect(typeof child.height).toBe("number");
        const corners = [
          [0, 0],
          [Number(child.width), 0],
          [0, Number(child.height)],
          [Number(child.width), Number(child.height)],
        ].map((corner) => transform(group, transform(child, corner)));
        const xs = corners.map(([x]) => x);
        const ys = corners.map(([, y]) => y);
        const actual = {
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
        };
        for (const key of ["x", "y", "width", "height"] as const) {
          // Emitted dimensions and offsets round to hundredths of a pixel.
          expect(Math.abs(actual[key] - target[key])).toBeLessThan(0.03);
        }
      }
    });
  });
}
