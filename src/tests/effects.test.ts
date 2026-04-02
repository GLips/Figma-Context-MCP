import { describe, expect, it } from "vitest";
import * as __testedFile from "../transformers/effects.js";

const hiddenEffect: any = {
  type: "DROP_SHADOW" as const,
  visible: false,
  color: { r: 255, g: 255, b: 255, a: 1 },
  offset: { x: 5, y: 5 },
  radius: 10,
};

const dropShadowEffect: any = {
  type: "DROP_SHADOW" as const,
  visible: true,
  color: { r: 0, g: 0, b: 0, a: 0.5 },
  offset: { x: 2, y: 2 },
  radius: 4,
  spread: 1,
};

const nodeBoxShadow: any = {
  type: "FRAME",
  effects: [
    dropShadowEffect,
    {
      type: "INNER_SHADOW",
      visible: true,
      color: { r: 1, g: 1, b: 1, a: 1 },
      offset: { x: 0, y: 0 },
      radius: 10,
      spread: 0,
    },
  ],
};

const nodeBoxShadowExpected = {
  boxShadow: "2px 2px 4px 1px rgba(0, 0, 0, 0.5), inset 0px 0px 10px 0px rgba(255, 255, 255, 1)",
};

const nodeBlur: any = {
  type: "RECTANGLE",
  effects: [
    { type: "LAYER_BLUR", visible: true, radius: 5 },
    { type: "BACKGROUND_BLUR", visible: true, radius: 15 },
  ],
};

const nodeMixed: any = {
  type: "COMPONENT",
  effects: [
    dropShadowEffect,
    {
      type: "DROP_SHADOW",
      visible: true,
      color: { r: 0, g: 0, b: 1, a: 1 },
      offset: { x: 2, y: 2 },
      radius: 2,
    },
    { type: "LAYER_BLUR", visible: true, radius: 2 },
    { type: "LAYER_BLUR", visible: true, radius: 4 },
  ],
};

const nodeMixedExpected = {
  boxShadow: "2px 2px 4px 1px rgba(0, 0, 0, 0.5), 2px 2px 2px 0px rgba(0, 0, 255, 1)",
  filter: "blur(2px) blur(4px)",
};

describe("src/transformers/effects.ts", () => {
  describe("buildSimplifiedEffects", () => {
    const { buildSimplifiedEffects } = __testedFile;
    // n: FigmaDocumentNode

    it("Full blur", () => {
      const n: Parameters<typeof buildSimplifiedEffects>[0] = nodeBlur;
      const __expectedResult: ReturnType<typeof buildSimplifiedEffects> = {
        filter: "blur(5px)",
        backdropFilter: "blur(15px)",
      };
      expect(buildSimplifiedEffects(n)).toEqual(__expectedResult);
    });

    it("Box shadow", () => {
      const n: Parameters<typeof buildSimplifiedEffects>[0] = nodeBoxShadow;
      const __expectedResult: ReturnType<typeof buildSimplifiedEffects> = nodeBoxShadowExpected;
      expect(buildSimplifiedEffects(n)).toEqual(__expectedResult);
    });

    it("Mixed & Multi", () => {
      const n: Parameters<typeof buildSimplifiedEffects>[0] = nodeMixed;
      const __expectedResult: ReturnType<typeof buildSimplifiedEffects> = nodeMixedExpected;
      expect(buildSimplifiedEffects(n)).toEqual(__expectedResult);
    });

    it("No effects", () => {
      const n: Parameters<typeof buildSimplifiedEffects>[0] = {
        type: "DOCUMENT",
        name: "Root",
      } as any;
      const __expectedResult: ReturnType<typeof buildSimplifiedEffects> = {};
      expect(buildSimplifiedEffects(n)).toEqual(__expectedResult);
    });

    it("Only visible effects", () => {
      const n: Parameters<typeof buildSimplifiedEffects>[0] = {
        type: "RECTANGLE",
        effects: [hiddenEffect, dropShadowEffect],
      } as any;
      const __expectedResult: ReturnType<typeof buildSimplifiedEffects> = {
        boxShadow: "2px 2px 4px 1px rgba(0, 0, 0, 0.5)",
      };
      expect(buildSimplifiedEffects(n)).toEqual(__expectedResult);
    });

    it("Text shadow", () => {
      const n: Parameters<typeof buildSimplifiedEffects>[0] = {
        type: "TEXT",
        effects: [dropShadowEffect],
      } as any;
      const __expectedResult: ReturnType<typeof buildSimplifiedEffects> = {
        textShadow: "2px 2px 4px 1px rgba(0, 0, 0, 0.5)",
      };
      expect(buildSimplifiedEffects(n)).toEqual(__expectedResult);
    });
  });
});

// 3TG (https://3tg.dev) created 6 tests in 2545 ms (424.167 ms per generated test) @ 2026-04-02T16:28:40.490Z
