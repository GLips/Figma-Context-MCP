import { describe, it, expect } from "vitest";
import { buildSimplifiedInteractions } from "~/transformers/interaction.js";
import { interactionExtractor } from "~/extractors/built-in.js";
import { extractFromDesign } from "~/extractors/node-walker.js";
import type { Node as FigmaDocumentNode } from "@figma/rest-api-spec";
import type { SimplifiedNode, TraversalContext } from "~/extractors/types.js";

function makeNode(overrides: Record<string, unknown> = {}): FigmaDocumentNode {
  return {
    id: "1:1",
    name: "Button",
    type: "FRAME",
    visible: true,
    ...overrides,
  } as unknown as FigmaDocumentNode;
}

describe("buildSimplifiedInteractions", () => {
  it("returns undefined for nodes without interactions", () => {
    const node = makeNode();
    expect(buildSimplifiedInteractions(node)).toBeUndefined();
  });

  it("returns undefined for nodes with empty interactions array", () => {
    const node = makeNode({ interactions: [] });
    expect(buildSimplifiedInteractions(node)).toBeUndefined();
  });

  it("extracts ON_CLICK trigger with NODE navigate action", () => {
    const node = makeNode({
      interactions: [
        {
          trigger: { type: "ON_CLICK" },
          actions: [
            {
              type: "NODE",
              destinationId: "4:1539",
              navigation: "NAVIGATE",
              transition: {
                type: "DISSOLVE",
                duration: 300,
                easing: { type: "EASE_OUT" },
              },
              preserveScrollPosition: false,
            },
          ],
        },
      ],
    });

    const result = buildSimplifiedInteractions(node);
    expect(result).toHaveLength(1);
    expect(result![0].trigger).toEqual({ type: "ON_CLICK" });
    expect(result![0].actions).toHaveLength(1);
    expect(result![0].actions[0]).toEqual({
      type: "NODE",
      destinationId: "4:1539",
      navigation: "NAVIGATE",
      transition: {
        type: "DISSOLVE",
        duration: 300,
        easing: "EASE_OUT",
      },
    });
  });

  it("extracts ON_HOVER trigger", () => {
    const node = makeNode({
      interactions: [
        {
          trigger: { type: "ON_HOVER" },
          actions: [
            {
              type: "NODE",
              destinationId: "10:1",
              navigation: "OVERLAY",
              transition: null,
            },
          ],
        },
      ],
    });

    const result = buildSimplifiedInteractions(node);
    expect(result![0].trigger.type).toBe("ON_HOVER");
    expect(result![0].actions[0]).toEqual({
      type: "NODE",
      destinationId: "10:1",
      navigation: "OVERLAY",
    });
  });

  it("extracts AFTER_TIMEOUT trigger with timeout value", () => {
    const node = makeNode({
      interactions: [
        {
          trigger: { type: "AFTER_TIMEOUT", timeout: 2000 },
          actions: [{ type: "NODE", destinationId: "5:1", navigation: "NAVIGATE", transition: null }],
        },
      ],
    });

    const result = buildSimplifiedInteractions(node);
    expect(result![0].trigger).toEqual({ type: "AFTER_TIMEOUT", timeout: 2000 });
  });

  it("extracts MOUSE_ENTER trigger with delay", () => {
    const node = makeNode({
      interactions: [
        {
          trigger: { type: "MOUSE_ENTER", delay: 500 },
          actions: [{ type: "BACK" }],
        },
      ],
    });

    const result = buildSimplifiedInteractions(node);
    expect(result![0].trigger).toEqual({ type: "MOUSE_ENTER", delay: 500 });
    expect(result![0].actions[0]).toEqual({ type: "BACK" });
  });

  it("extracts URL action", () => {
    const node = makeNode({
      interactions: [
        {
          trigger: { type: "ON_CLICK" },
          actions: [{ type: "URL", url: "https://example.com" }],
        },
      ],
    });

    const result = buildSimplifiedInteractions(node);
    expect(result![0].actions[0]).toEqual({
      type: "URL",
      url: "https://example.com",
    });
  });

  it("extracts BACK and CLOSE actions", () => {
    const node = makeNode({
      interactions: [
        {
          trigger: { type: "ON_CLICK" },
          actions: [{ type: "BACK" }, { type: "CLOSE" }],
        },
      ],
    });

    const result = buildSimplifiedInteractions(node);
    expect(result![0].actions).toEqual([{ type: "BACK" }, { type: "CLOSE" }]);
  });

  it("extracts directional transition with direction", () => {
    const node = makeNode({
      interactions: [
        {
          trigger: { type: "ON_CLICK" },
          actions: [
            {
              type: "NODE",
              destinationId: "2:1",
              navigation: "NAVIGATE",
              transition: {
                type: "SLIDE_IN",
                direction: "LEFT",
                duration: 200,
                easing: { type: "EASE_IN_AND_OUT" },
                matchLayers: false,
              },
            },
          ],
        },
      ],
    });

    const result = buildSimplifiedInteractions(node);
    const action = result![0].actions[0] as { transition: { type: string; direction: string } };
    expect(action.transition.type).toBe("SLIDE_IN");
    expect(action.transition.direction).toBe("LEFT");
  });

  it("extracts SMART_ANIMATE transition", () => {
    const node = makeNode({
      interactions: [
        {
          trigger: { type: "ON_CLICK" },
          actions: [
            {
              type: "NODE",
              destinationId: "3:1",
              navigation: "NAVIGATE",
              transition: {
                type: "SMART_ANIMATE",
                duration: 500,
                easing: { type: "EASE_IN" },
              },
            },
          ],
        },
      ],
    });

    const result = buildSimplifiedInteractions(node);
    const action = result![0].actions[0] as { transition: { type: string; easing: string } };
    expect(action.transition.type).toBe("SMART_ANIMATE");
    expect(action.transition.easing).toBe("EASE_IN");
  });

  it("handles multiple interactions on a single node", () => {
    const node = makeNode({
      interactions: [
        {
          trigger: { type: "ON_CLICK" },
          actions: [
            { type: "NODE", destinationId: "1:1", navigation: "NAVIGATE", transition: null },
          ],
        },
        {
          trigger: { type: "ON_HOVER" },
          actions: [
            { type: "NODE", destinationId: "2:2", navigation: "OVERLAY", transition: null },
          ],
        },
      ],
    });

    const result = buildSimplifiedInteractions(node);
    expect(result).toHaveLength(2);
    expect(result![0].trigger.type).toBe("ON_CLICK");
    expect(result![1].trigger.type).toBe("ON_HOVER");
  });

  it("filters out interactions with null trigger", () => {
    const node = makeNode({
      interactions: [
        { trigger: null, actions: [{ type: "BACK" }] },
        {
          trigger: { type: "ON_CLICK" },
          actions: [
            { type: "NODE", destinationId: "1:1", navigation: "NAVIGATE", transition: null },
          ],
        },
      ],
    });

    const result = buildSimplifiedInteractions(node);
    expect(result).toHaveLength(1);
    expect(result![0].trigger.type).toBe("ON_CLICK");
  });
});

describe("interactionExtractor", () => {
  it("adds interactions to SimplifiedNode", () => {
    const node = makeNode({
      interactions: [
        {
          trigger: { type: "ON_CLICK" },
          actions: [
            { type: "NODE", destinationId: "4:1", navigation: "NAVIGATE", transition: null },
          ],
        },
      ],
    });

    const result: SimplifiedNode = { id: "1:1", name: "Button", type: "FRAME" };
    const context: TraversalContext = { globalVars: { styles: {} }, currentDepth: 0 };

    interactionExtractor(node, result, context);

    expect(result.interactions).toBeDefined();
    expect(result.interactions).toHaveLength(1);
    expect(result.interactions![0].trigger.type).toBe("ON_CLICK");
  });

  it("does not add interactions when node has none", () => {
    const node = makeNode();
    const result: SimplifiedNode = { id: "1:1", name: "Box", type: "FRAME" };
    const context: TraversalContext = { globalVars: { styles: {} }, currentDepth: 0 };

    interactionExtractor(node, result, context);

    expect(result.interactions).toBeUndefined();
  });
});

describe("interactionExtractor integration with extractFromDesign", () => {
  it("includes interactions in extracted nodes", () => {
    const nodes = [
      makeNode({
        interactions: [
          {
            trigger: { type: "ON_CLICK" },
            actions: [
              { type: "NODE", destinationId: "4:1", navigation: "NAVIGATE", transition: null },
            ],
          },
        ],
      }),
    ];

    const { nodes: extracted } = extractFromDesign(nodes, [interactionExtractor]);

    expect(extracted).toHaveLength(1);
    expect(extracted[0].interactions).toBeDefined();
    expect(extracted[0].interactions![0].trigger.type).toBe("ON_CLICK");
  });
});
