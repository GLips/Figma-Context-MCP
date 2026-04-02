# Exported functions from "src/transformers/layout.ts"

<!--
```json configuration
{ "testing-framework": "vitest" }
```
-->

## buildSimplifiedLayout(n: FigmaDocumentNode, parent?: FigmaDocumentNode)

These are the functional requirements for function `buildSimplifiedLayout`.

**FIXME**: we need better test values as all results are the same for and without a prent node.

| test name                | n                   | parent            | buildSimplifiedLayout                                                                          |
| ------------------------ | ------------------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| Non-Frame without parent | nodeNonFrame as any | undefined         | {mode:'none', dimensions:{width:50, height:50}, sizing:{horizontal:'fixed', vertical:'fixed'}} |
| Non-Frame with parent    | nodeNonFrame as any | parentNode as any | {mode:'none', dimensions:{width:50, height:50}, sizing:{horizontal:'fixed', vertical:'fixed'}} |

```typescript before
const parentNode = {
  type: "FRAME",
  layoutMode: "NONE",
  absoluteBoundingBox: { x: 0, y: 0, width: 500, height: 500 },
};

const nodeNonFrame = {
  type: "RECTANGLE",
  absoluteBoundingBox: { x: 100, y: 100, width: 50, height: 50 },
  layoutSizingHorizontal: "FIXED",
  layoutSizingVertical: "FIXED",
};
```

| test name              | n                  | parent            | buildSimplifiedLayout |
| ---------------------- | ------------------ | ----------------- | --------------------- |
| Stretch without parent | nodeStretch as any | undefined         | {mode:'none'}         |
| Stretch with parent    | nodeStretch as any | parentNode as any | {mode:'none'}         |

```typescript before
const nodeStretch = {
  type: "FRAME",
  layoutMode: "HORIZONTAL",
  primaryAxisAlignItems: "CENTER",
  children: [
    { type: "RECTANGLE", layoutSizingHorizontal: "FILL" },
    { type: "FRAME", layoutSizingHorizontal: "FILL" },
    { type: "VECTOR", layoutPositioning: "ABSOLUTE" },
  ],
};
```

| test name                           | n                              | parent            | buildSimplifiedLayout         |
| ----------------------------------- | ------------------------------ | ----------------- | ----------------------------- |
| Absolute Positioning without parent | nodeAbsolutePositioning as any | undefined         | nodeAbsolutePositioningResult |
| Absolute Positioning with parent    | nodeAbsolutePositioning as any | parentNode as any | nodeAbsolutePositioningResult |

```typescript before
const nodeAbsolutePositioning = {
  type: "RECTANGLE",
  layoutPositioning: "ABSOLUTE",
  absoluteBoundingBox: { x: 50, y: 50, width: 100, height: 100 },
  layoutSizingHorizontal: "FIXED",
  layoutSizingVertical: "FIXED",
};
const nodeAbsolutePositioningResult = {
  dimensions: {
    height: 100,
    width: 100,
  },
  mode: "none" as const,
  sizing: {
    horizontal: "fixed" as const,
    vertical: "fixed" as const,
  },
};
```

| test name               | n                   | parent            | buildSimplifiedLayout |
| ----------------------- | ------------------- | ----------------- | --------------------- |
| Overflow without parent | nodeOverflow as any | undefined         | {mode:'none'}         |
| Overflow with parent    | nodeOverflow as any | parentNode as any | {mode:'none'}         |

```typescript before
const nodeOverflow = {
  type: "FRAME",
  layoutMode: "VERTICAL",
  overflowDirection: ["HORIZONTAL", "VERTICAL"],
  paddingTop: 10,
  paddingBottom: 10,
  paddingLeft: 20,
  paddingRight: 20,
  itemSpacing: 8,
};
```

| test name                   | n                      | parent            | buildSimplifiedLayout                                      |
| --------------------------- | ---------------------- | ----------------- | ---------------------------------------------------------- |
| Aspect Ratio without parent | nodeAspectRatio as any | undefined         | {sizing: {horizontal:'hug', vertical:'fill'}, mode:'none'} |
| Aspect Ratio with parent    | nodeAspectRatio as any | parentNode as any | {sizing: {horizontal:'hug', vertical:'fill'}, mode:'none'} |

```typescript before
const nodeAspectRatio = {
  type: "FRAME",
  layoutMode: "VERTICAL",
  layoutSizingHorizontal: "HUG",
  layoutSizingVertical: "FILL",
  layoutAlign: "STRETCH",
  preserveRatio: true,
  absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
};
```
