# Exported functions from "src/transformers/effects.ts"

<!--
```json configuration
{ "testing-framework": "vitest" }
```
-->

## buildSimplifiedEffects(n: FigmaDocumentNode)

These are the functional requirements for function `buildSimplifiedEffects`.

| test name            | n                                                                       | buildSimplifiedEffects                           |
| -------------------- | ----------------------------------------------------------------------- | ------------------------------------------------ |
| No effects           | { type: "DOCUMENT", name: "Root" } as any                               | {}                                               |
| Only visible effects | { type: "RECTANGLE", effects: [hiddenEffect, dropShadowEffect] } as any | {boxShadow:'2px 2px 4px 1px rgba(0, 0, 0, 0.5)'} |

```typescript before
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
```

| test name  | n             | buildSimplifiedEffects |
| ---------- | ------------- | ---------------------- |
| Box shadow | nodeBoxShadow | nodeBoxShadowExpected  |

```typescript before
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
```

| test name   | n                                                    | buildSimplifiedEffects                              |
| ----------- | ---------------------------------------------------- | --------------------------------------------------- |
| Text shadow | { type: "TEXT", effects: [dropShadowEffect] } as any | { textShadow:'2px 2px 4px 1px rgba(0, 0, 0, 0.5)' } |
| Full blur   | nodeBlur                                             | { filter:'blur(5px)', backdropFilter:'blur(15px)' } |

```typescript before
const nodeBlur: any = {
  type: "RECTANGLE",
  effects: [
    { type: "LAYER_BLUR", visible: true, radius: 5 },
    { type: "BACKGROUND_BLUR", visible: true, radius: 15 },
  ],
};
```

| test name     | n         | buildSimplifiedEffects |
| ------------- | --------- | ---------------------- |
| Mixed & Multi | nodeMixed | nodeMixedExpected      |

```typescript before
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
```
