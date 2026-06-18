import { describe, expect, it } from "vitest";
import { parsePaint } from "~/transformers/style.js";
import type { Paint } from "@figma/rest-api-spec";

// A vertical (180deg) black→transparent linear gradient. Only `opacity` varies
// between cases, so any difference in the emitted stops is the paint-level
// opacity being applied (or dropped).
function verticalBlackToTransparent(opacity?: number): Paint {
  return {
    type: "GRADIENT_LINEAR",
    ...(opacity === undefined ? {} : { opacity }),
    gradientHandlePositions: [
      { x: 0.5, y: 0 },
      { x: 0.5, y: 1 },
      { x: 1, y: 0 },
    ],
    gradientStops: [
      { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
      { position: 1, color: { r: 0, g: 0, b: 0, a: 0 } },
    ],
  } as unknown as Paint;
}

function gradientCss(opacity?: number): string {
  const result = parsePaint(verticalBlackToTransparent(opacity)) as { gradient: string };
  return result.gradient;
}

describe("parsePaint — gradient paint opacity", () => {
  it("multiplies paint opacity into each stop's alpha", () => {
    expect(gradientCss(0.5)).toContain("rgba(0, 0, 0, 0.5) 0%");
  });

  // A fully-transparent stop stays transparent regardless of paint opacity.
  it("leaves an alpha-0 stop transparent", () => {
    expect(gradientCss(0.5)).toContain("rgba(0, 0, 0, 0) 100%");
  });

  // Regression guard: the default (opacity 1 / absent) must not change output.
  it("emits opaque stops when paint opacity is absent", () => {
    expect(gradientCss(undefined)).toContain("rgba(0, 0, 0, 1) 0%");
  });

  // Paint opacity and a stop's intrinsic alpha are multiplicative, not either-or:
  // a stop at alpha 0.4 under a 0.5-opacity paint resolves to 0.2.
  it("multiplies paint opacity with a stop's intrinsic alpha", () => {
    const paint = {
      type: "GRADIENT_LINEAR",
      opacity: 0.5,
      gradientHandlePositions: [
        { x: 0.5, y: 0 },
        { x: 0.5, y: 1 },
        { x: 1, y: 0 },
      ],
      gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 0.4 } }],
    } as unknown as Paint;
    const { gradient } = parsePaint(paint) as { gradient: string };
    expect(gradient).toContain("rgba(0, 0, 0, 0.2)");
  });

  // Non-linear types route stop formatting through a different geometry mapper;
  // confirm paint opacity reaches a radial gradient's stops too.
  it("applies paint opacity to non-linear (radial) gradients", () => {
    const paint = {
      type: "GRADIENT_RADIAL",
      opacity: 0.5,
      gradientHandlePositions: [
        { x: 0.5, y: 0.5 },
        { x: 1, y: 0.5 },
        { x: 0.5, y: 1 },
      ],
      gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }],
    } as unknown as Paint;
    const { gradient } = parsePaint(paint) as { gradient: string };
    expect(gradient).toContain("rgba(0, 0, 0, 0.5)");
  });
});

// Each gradient type maps to a specific CSS function (linear/radial/conic) and a
// specific geometry string. These pin the full output per type so a refactor of
// the type→renderer dispatch can't silently swap a wrapper or drop geometry.
function renderGradient(type: string, handles: { x: number; y: number }[]): string {
  const paint = {
    type,
    gradientHandlePositions: handles,
    gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }],
  } as unknown as Paint;
  return (parsePaint(paint) as { gradient: string }).gradient;
}

describe("parsePaint — gradient type to CSS function + geometry", () => {
  // Centered handles shared by the three non-linear types: center, edge, width.
  const centered = [
    { x: 0.5, y: 0.5 },
    { x: 1, y: 0.5 },
    { x: 0.5, y: 1 },
  ];

  it("renders a linear gradient with a degree angle", () => {
    const handles = [
      { x: 0.5, y: 0 },
      { x: 0.5, y: 1 },
      { x: 1, y: 0 },
    ];
    expect(renderGradient("GRADIENT_LINEAR", handles)).toBe(
      "linear-gradient(180deg, rgba(0, 0, 0, 1) 0%)",
    );
  });

  it("renders a radial gradient as a circle", () => {
    expect(renderGradient("GRADIENT_RADIAL", centered)).toBe(
      "radial-gradient(circle at 50% 50%, rgba(0, 0, 0, 1) 0%)",
    );
  });

  it("renders an angular gradient as a conic gradient", () => {
    expect(renderGradient("GRADIENT_ANGULAR", centered)).toBe(
      "conic-gradient(from 90deg at 50% 50%, rgba(0, 0, 0, 1) 0%)",
    );
  });

  it("renders a diamond gradient as a radial ellipse", () => {
    expect(renderGradient("GRADIENT_DIAMOND", centered)).toBe(
      "radial-gradient(ellipse at 50% 50%, rgba(0, 0, 0, 1) 0%)",
    );
  });
});
