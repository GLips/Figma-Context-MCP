import { describe, it, expect } from "vitest";
import { simplify, type SimplifiedNode } from "@framelink/core";
import type { GetFileNodesResponse, GetFileResponse } from "@figma/rest-api-spec";
import { parseRestResponse } from "~/adapters/rest/decode/response.js";
import { readRestDesign, type RestDesignSource } from "~/adapters/rest/read-rest-design.js";
import { figmaFileKey, figmaNodeId } from "~/utils/figma-url.js";

// A-7: a nested node reads the same whether targeted or reached through its parent. These are
// ids-filtered file responses, where each ancestor lists only the child on the path.

const box = (x: number, y: number, width: number, height: number) => ({
  absoluteBoundingBox: { x, y, width, height },
  layoutSizingHorizontal: "FIXED",
  layoutSizingVertical: "FIXED",
});
const frame = (id: string, extra: object, children: object[]) => ({
  id,
  name: id,
  type: "FRAME",
  clipsContent: true,
  ...extra,
  children,
});
const rect = (id: string, extra: object) => ({ id, name: id, type: "RECTANGLE", ...extra });

function fileOf(...topLevel: object[]): GetFileResponse {
  return {
    name: "file",
    components: {},
    componentSets: {},
    styles: {},
    document: {
      id: "0:0",
      name: "Document",
      type: "DOCUMENT",
      children: [{ id: "0:1", name: "Page", type: "CANVAS", children: topLevel }],
    },
  } as unknown as GetFileResponse;
}

async function read(file: GetFileResponse | GetFileNodesResponse, nodeId?: string) {
  const { snapshots, placement } = parseRestResponse(file, nodeId);
  const { nodes } = await simplify(snapshots, { placement });
  return nodes[0];
}

function withoutSource({ readOnlySource: _, children, ...node }: SimplifiedNode): object {
  return { ...node, children: children?.map(withoutSource) };
}

describe("targeted REST reads", () => {
  it("keep a nested node's sizing and position; a canvas-level frame stays contextual", async () => {
    const file = fileOf(
      frame("1:1", box(100, 100, 402, 800), [
        frame("1:2", { ...box(100, 100, 402, 800), layoutMode: "VERTICAL" }, [
          rect("1:3", { ...box(100, 100, 402, 94), layoutSizingHorizontal: "FILL" }),
          rect("1:4", { ...box(150, 300, 40, 40), layoutPositioning: "ABSOLUTE" }),
        ]),
      ]),
      {
        id: "5:1",
        name: "Section",
        type: "SECTION",
        ...box(0, 2000, 900, 900),
        children: [frame("5:2", box(40, 2040, 402, 800), [])],
      },
    );

    const throughParent = await read(file, "1:2");
    for (const [index, id] of ["1:3", "1:4"].entries()) {
      expect(withoutSource(await read(file, id))).toEqual(
        withoutSource(throughParent.children![index]),
      );
    }
    expect(throughParent.children![1]).toMatchObject({
      width: 40,
      position: "absolute",
      left: 50,
      top: 200,
    });

    const screen = await read(file, "1:1");
    expect([screen.width, screen.designedWidth, screen.left]).toEqual([
      "contextual",
      "402px",
      undefined,
    ]);
    const inSection = await read(file, "5:2");
    expect([inSection.width, inSection.left]).toEqual(["contextual", undefined]);
  });

  it("place a grid child against siblings the ancestor chain leaves out", async () => {
    const grid = {
      ...box(0, 0, 120, 80),
      layoutMode: "GRID",
      gridColumnsSizing: "60px 60px",
      gridRowsSizing: "40px 40px",
    };
    const cell = (id: string, column: number, row: number) =>
      rect(id, {
        ...box(column * 60, row * 40, 10, 10),
        gridColumnAnchorIndex: column,
        gridRowAnchorIndex: row,
      });
    const file = fileOf(
      frame("2:0", box(0, 0, 200, 200), [frame("2:1", grid, [cell("2:2", 0, 0)])]),
    );
    // One cell left empty, so the grid is unpacked and placement is explicit.
    const siblings = {
      name: "file",
      nodes: {
        "2:1": {
          document: frame("2:1", grid, [cell("2:2", 0, 0), cell("2:3", 1, 1)]),
          components: {},
          componentSets: {},
          styles: {},
        },
      },
    } as unknown as GetFileNodesResponse;
    const calls: unknown[][] = [];
    const source = {
      getRawNodeInContext: async () => ({ data: file, rawSize: 0 }),
      getRawNodes: async (...args: unknown[]) => (calls.push(args), siblings),
    } as unknown as RestDesignSource;

    const { design } = await readRestDesign(source, {
      fileKey: figmaFileKey("file"),
      nodeId: figmaNodeId("2:2"),
    });

    expect(calls).toEqual([["file", ["2:1"], 1]]);
    expect(design.nodes[0].layout).toMatchObject({ gridColumn: "1", gridRow: "1" });
  });
});
