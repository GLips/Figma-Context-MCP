import { describe, expect, it } from "vitest";
import { simplifyRawFigmaObject } from "~/extractors/design-extractor.js";
import { allExtractors } from "~/extractors/built-in.js";
import { getFigmaDataTool } from "~/mcp/tools/get-figma-data-tool.js";
import { countNamedStyles, detectVariables } from "~/services/get-figma-data-metrics.js";
import { getErrorMeta } from "~/utils/error-meta.js";
import type { GetFileNodesResponse, Node as FigmaNode, Style } from "@figma/rest-api-spec";

// Same casting strategy as tree-walker.test.ts: the walker only reads a small
// subset of the deeply-discriminated Figma node union, so build fixtures loosely
// and cast through unknown.
function makeNode(overrides: Record<string, unknown>): FigmaNode {
  return { visible: true, ...overrides } as unknown as FigmaNode;
}

type NodeEntry = { document: FigmaNode; styles?: Record<string, Style> } | null;

// A GetFileNodesResponse entry wraps each requested node's document plus its
// associated components/styles. A null entry means the API couldn't resolve it.
function makeNodesResponse(nodes: Record<string, NodeEntry>): GetFileNodesResponse {
  const wrapped: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(nodes)) {
    wrapped[id] =
      value === null
        ? null
        : {
            document: value.document,
            components: {},
            componentSets: {},
            styles: value.styles ?? {},
          };
  }
  return { name: "Test File", nodes: wrapped } as unknown as GetFileNodesResponse;
}

const RED_FILL = [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, visible: true }];

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

// The whole point of fetching multiple roots in one call is that the clever
// passes (style hoisting, element templating) still see the combined forest.
// These assert dedup spans node boundaries, not just within a single root.
describe("cross-node deduplication", () => {
  it("hoists a style shared across two separate top-level nodes", async () => {
    // Distinct node types so their bodies differ — this isolates STYLE dedup from
    // ELEMENT dedup (identical bodies would template away the `fills` field).
    const response = makeNodesResponse({
      "1:2": { document: makeNode({ id: "1:2", name: "Frame A", type: "FRAME", fills: RED_FILL }) },
      "3:4": {
        document: makeNode({ id: "3:4", name: "Box B", type: "RECTANGLE", fills: RED_FILL }),
      },
    });

    const result = await simplifyRawFigmaObject(response, allExtractors);

    // Same fill in either root → same content-addressed ref → counted twice →
    // kept hoisted (not inlined). Both nodes point at the one shared entry.
    const fillsA = result.nodes[0].fills;
    const fillsB = result.nodes[1].fills;
    expect(typeof fillsA).toBe("string");
    expect(fillsA).toBe(fillsB);
    expect(result.globalVars.styles[fillsA as string]).toBeDefined();

    const fillEntries = Object.keys(result.globalVars.styles).filter((k) => k.startsWith("fill"));
    expect(fillEntries).toHaveLength(1);
  });

  it("inlines a style used by only one node, even when other nodes are present", async () => {
    const response = makeNodesResponse({
      "1:2": { document: makeNode({ id: "1:2", name: "Frame A", type: "FRAME", fills: RED_FILL }) },
      "3:4": { document: makeNode({ id: "3:4", name: "Frame B", type: "FRAME" }) },
    });

    const result = await simplifyRawFigmaObject(response, allExtractors);

    // Single use across the whole forest → inlined back onto the node, nothing
    // left hoisted.
    expect(Array.isArray(result.nodes[0].fills)).toBe(true);
    expect(Object.keys(result.globalVars.styles)).toHaveLength(0);
  });

  it("templates structurally identical subtrees that live under different roots", async () => {
    const child = () => makeNode({ id: "c", name: "Box", type: "RECTANGLE", fills: RED_FILL });
    const response = makeNodesResponse({
      "1:2": {
        document: makeNode({ id: "1:2", name: "Frame A", type: "FRAME", children: [child()] }),
      },
      "3:4": {
        document: makeNode({ id: "3:4", name: "Frame B", type: "FRAME", children: [child()] }),
      },
    });

    const result = await simplifyRawFigmaObject(response, allExtractors);

    // The identical rectangle appears once under each root → one shared element
    // template, each occurrence reduced to a `template` ref.
    expect(Object.keys(result.elements)).toHaveLength(1);
    const [templateId] = Object.keys(result.elements);
    expect(result.nodes[0].children![0].template).toBe(templateId);
    expect(result.nodes[1].children![0].template).toBe(templateId);
  });
});

// Regression: a partial miss (some ids resolve, some are null) used to crash the
// metrics pass — which runs on the raw response after simplify — because it
// dereferenced every node entry as non-null.
describe("metrics tolerate null node entries (partial miss)", () => {
  const response = makeNodesResponse({
    "1:2": {
      document: makeNode({
        id: "1:2",
        name: "Frame A",
        type: "FRAME",
        boundVariables: { fills: [{ type: "VARIABLE_ALIAS", id: "VariableID:1:1" }] },
      }),
      styles: { "S:1": { name: "Brand/Primary" } as Style },
    },
    "9:9": null,
  });

  it("countNamedStyles ignores the null entry", () => {
    expect(() => countNamedStyles(response)).not.toThrow();
    expect(countNamedStyles(response)).toBe(1);
  });

  it("detectVariables ignores the null entry", () => {
    expect(() => detectVariables(response)).not.toThrow();
    expect(detectVariables(response)).toBe(true);
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
