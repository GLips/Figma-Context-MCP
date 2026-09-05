import { describe, expect, it } from "vitest";
import type {
  GetFileResponse,
  GetFileNodesResponse,
  Node as FigmaNode,
} from "@figma/rest-api-spec";
import { fetchComponentDefinitions } from "~/adapters/rest/component-definitions.js";
import { simplifyRestResponse } from "~/adapters/rest/rest.js";
import type { FigmaService } from "~/services/figma.js";

// The fetched upgrade: when a read instantiates a component whose subtree it didn't fetch, ask
// Figma for the real definition instead of donating some instance's already-edited children. Every
// failure here is a fallback, not an error, so both halves are pinned: that the two-hop remote
// lookup lands the definition under the id the READ uses, and that a refusal leaves the donor floor
// standing rather than failing the read.

function node(overrides: Record<string, unknown>): FigmaNode {
  return { visible: true, ...overrides } as unknown as FigmaNode;
}

// A page holding two instances of ONE published library component. The component's own subtree is
// not here — that is the whole point — and the second instance has renamed a sublayer, so a donated
// body would carry that rename as if the component had it.
const CONSUMING_FILE = {
  name: "Consumer",
  document: {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    children: [
      node({
        id: "1:1",
        name: "Page 1",
        type: "CANVAS",
        children: [
          node({
            id: "2:1",
            name: "Button",
            type: "INSTANCE",
            componentId: "9:1",
            children: [node({ id: "I2:1;5:2", name: "Label", type: "TEXT", characters: "Save" })],
          }),
          node({
            id: "2:2",
            name: "Button",
            type: "INSTANCE",
            componentId: "9:1",
            children: [
              node({ id: "I2:2;5:2", name: "Renamed", type: "TEXT", characters: "Cancel" }),
            ],
          }),
        ],
      }),
    ],
  },
  components: {
    "9:1": {
      key: "pub-button",
      name: "Button",
      description: "",
      documentationLinks: [],
      remote: true,
    },
  },
  componentSets: {},
  styles: {},
} as unknown as GetFileResponse;

// What the library file answers with. The definition's node id is the LIBRARY's (`77:7`), not the
// `9:1` the consuming file knows the component by — the rewrite is what makes the two meet.
const LIBRARY_RESPONSE = {
  name: "Design System",
  nodes: {
    "77:7": {
      document: node({
        id: "77:7",
        name: "Button",
        type: "COMPONENT",
        children: [node({ id: "5:2", name: "Label", type: "TEXT", characters: "Label" })],
      }),
      components: {},
      componentSets: {},
      styles: {},
    },
  },
} as unknown as GetFileNodesResponse;

function stubService(overrides: Partial<FigmaService>): FigmaService {
  return {
    getPublishedComponentSite: async () => ({ fileKey: "lib", nodeId: "77:7" }),
    getRawNodes: async () => LIBRARY_RESPONSE,
    ...overrides,
  } as unknown as FigmaService;
}

describe("off-tree component definitions", () => {
  it("resolves a published component in two hops and publishes it under the id the read uses", async () => {
    const asked: string[] = [];
    const service = stubService({
      getPublishedComponentSite: async (key: string) => {
        asked.push(key);
        return { fileKey: "lib", nodeId: "77:7" };
      },
    });

    const definitions = await fetchComponentDefinitions(service, "consumer", CONSUMING_FILE);
    // One lookup for the one component, however many instances referenced it.
    expect(asked).toEqual(["pub-button"]);
    expect(definitions.map((d) => d.id)).toEqual(["9:1"]);

    const design = await simplifyRestResponse(CONSUMING_FILE, {
      componentDefinitions: definitions,
    });
    const entry = design.components["9:1"];
    // No `childrenFrom`: these children are the definition's own, not a worked example.
    expect(entry.childrenFrom).toBeUndefined();
    expect(entry.children?.map((child) => child.name)).toEqual(["Label"]);
    // Both instances now read as diffs against it — the rename and the text the designer typed,
    // keyed by the sublayer's component-relative path.
    expect(design.nodes[0].children?.[1].overrides).toEqual({
      "5:2": { name: "Renamed", text: "Cancel" },
    });
  });

  it("falls back to the donor floor when the library is unreachable", async () => {
    const service = stubService({
      getPublishedComponentSite: async () => {
        throw new Error("403 Forbidden");
      },
    });

    const definitions = await fetchComponentDefinitions(service, "consumer", CONSUMING_FILE);
    expect(definitions).toEqual([]);

    const design = await simplifyRestResponse(CONSUMING_FILE, {
      componentDefinitions: definitions,
    });
    // An instance donated instead, and says so — its own edits are baked into these children.
    expect(design.components["9:1"].childrenFrom).toBeTruthy();
    expect(design.components["9:1"].children).toHaveLength(1);
  });
});
