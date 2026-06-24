import { describe, expect, it } from "vitest";
import { simplifyRawFigmaObject } from "~/extractors/design-extractor.js";
import { allExtractors } from "~/extractors/built-in.js";
import { getFigmaDataTool } from "~/mcp/tools/get-figma-data-tool.js";
import { getErrorMeta } from "~/utils/error-meta.js";
import type { GetFileNodesResponse, Node as FigmaNode } from "@figma/rest-api-spec";

// Same casting strategy as tree-walker.test.ts: the walker only reads a small
// subset of the deeply-discriminated Figma node union, so build fixtures loosely
// and cast through unknown.
function makeNode(overrides: Record<string, unknown>): FigmaNode {
  return { visible: true, ...overrides } as unknown as FigmaNode;
}

// A GetFileNodesResponse entry wraps each requested node's document plus its
// associated components/styles. A null entry means the API couldn't resolve it.
function makeNodesResponse(
  nodes: Record<string, { document: FigmaNode } | null>,
): GetFileNodesResponse {
  const wrapped: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(nodes)) {
    wrapped[id] =
      value === null
        ? null
        : { document: value.document, components: {}, componentSets: {}, styles: {} };
  }
  return { name: "Test File", nodes: wrapped } as unknown as GetFileNodesResponse;
}

describe("multi-node GetFileNodesResponse handling", () => {
  it("aggregates every returned node into the top-level nodes array", async () => {
    const response = makeNodesResponse({
      "1:2": { document: makeNode({ id: "1:2", name: "Frame A", type: "FRAME" }) },
      "3:4": { document: makeNode({ id: "3:4", name: "Frame B", type: "FRAME" }) },
    });

    const result = await simplifyRawFigmaObject(response, allExtractors);

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.map((n) => n.name)).toEqual(["Frame A", "Frame B"]);
    expect(result.nodes.map((n) => n.id)).toEqual(["1:2", "3:4"]);
  });

  it("skips null entries and resolves with just the found nodes", async () => {
    const response = makeNodesResponse({
      "1:2": { document: makeNode({ id: "1:2", name: "Frame A", type: "FRAME" }) },
      "9:9": null,
    });

    const result = await simplifyRawFigmaObject(response, allExtractors);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].name).toBe("Frame A");
  });

  it("rejects with a not_found error when every requested node is null", async () => {
    const response = makeNodesResponse({ "1:2": null, "3:4": null });

    await expect(simplifyRawFigmaObject(response, allExtractors)).rejects.toMatchObject({
      message: expect.stringContaining("No requested nodes were found"),
    });

    const error = await simplifyRawFigmaObject(response, allExtractors).catch((e) => e);
    expect(getErrorMeta(error).category).toBe("not_found");
  });

  it("rejects with not_found (not a TypeError) on an empty nodes object", async () => {
    const response = makeNodesResponse({});

    const error = await simplifyRawFigmaObject(response, allExtractors).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect(getErrorMeta(error).category).toBe("not_found");
    expect((error as Error).message).toContain("No requested nodes were found");
  });
});

describe("get_figma_data nodeId schema", () => {
  it("accepts a comma-separated list of node ids", () => {
    const result = getFigmaDataTool.parametersSchema.safeParse({
      fileKey: "abc",
      nodeId: "1:2,3:4",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed node id", () => {
    const result = getFigmaDataTool.parametersSchema.safeParse({
      fileKey: "abc",
      nodeId: "not a node id",
    });
    expect(result.success).toBe(false);
  });
});
