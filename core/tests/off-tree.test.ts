import { expect, test } from "vitest";
import { offTreeComponentIds } from "../src/index.js";
import type { NodeSnapshot } from "../src/snapshot.js";

const instance = (id: string, componentId: string, extra: Partial<NodeSnapshot> = {}) =>
  ({ id, name: id, type: "INSTANCE", componentId, ...extra }) as NodeSnapshot;

// What a REST read pays a request for: only components the projected output will publish.
const page: NodeSnapshot = {
  id: "0",
  name: "Page",
  type: "FRAME",
  children: [
    instance("1", "shown"),
    instance("2", "hidden", { visible: false }),
    {
      id: "3",
      name: "Card",
      type: "COMPONENT",
      children: [
        // Hidden, but a property drives it: some instance turns it on, so the wire keeps it.
        instance("4", "toggled", {
          visible: false,
          componentPropertyReferences: { visible: "Show#1:0" },
        }),
        { id: "5", name: "Deep", type: "FRAME", children: [instance("6", "deep")] },
      ],
    },
    instance("7", "3"),
  ],
};

test("a wire read wants what projection publishes; a runtime read wants every reference", () => {
  expect(offTreeComponentIds([page], { read: "wire" })).toEqual(["shown", "toggled", "deep"]);
  expect(offTreeComponentIds([page], { read: "wire", maxDepth: 2 })).toEqual(["shown", "toggled"]);
  expect(offTreeComponentIds([page], { read: "runtime" })).toEqual([
    "shown",
    "hidden",
    "toggled",
    "deep",
  ]);
});
