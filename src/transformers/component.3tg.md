# Exported functions from "src/transformers/component.ts"

<!--
```json configuration
{ "testing-framework": "vitest" }
```
-->

## simplifyComponents(aggregatedComponents: Record<string, Component>)

These are the functional requirements for function `simplifyComponents`.

| test name   | aggregatedComponents | simplifyComponents         |
| ----------- | -------------------- | -------------------------- |
|             | {}                   | {}                         |
| No set ID   | agNoComponentSetId   | scNoComponentSetIdResponse |
| With set ID | agComponent          | scComponentSetIdResponse   |

```typescript before
const agNoComponentSetId = {
  1: {
    key: "abc123def456",
    name: "IconButton",
    description: "A simple icon button",
    documentationLinks: [],
    remote: false,
  },
};

const scNoComponentSetIdResponse = {
  "1": {
    key: "abc123def456",
    name: "IconButton",
    id: "1",
    componentSetId: undefined,
  },
};

const agComponent = {
  1: {
    key: "abc123def456",
    name: "IconButton",
    description: "A simple icon button",
    documentationLinks: [],
    remote: false,
    componentSetId: "csid",
  },
};

const scComponentSetIdResponse = {
  "1": {
    key: "abc123def456",
    name: "IconButton",
    id: "1",
    componentSetId: "csid",
  },
};
```

## simplifyComponentSets(aggregatedComponentSets: Record<string, ComponentSet>)

These are the functional requirements for function `simplifyComponentSets`.

| test name        | aggregatedComponentSets | simplifyComponentSets   |
| ---------------- | ----------------------- | ----------------------- |
|                  | {}                      | {}                      |
| No description   | agNoDescription         | scNoDescriptionResponse |
| With description | agComponent             | scDescriptionResponse   |

```typescript before
const agNoDescription = {
  1: {
    key: "abc123def456",
    name: "IconButton",
    description: "",
    documentationLinks: [],
    remote: false,
    componentSetId: "csid",
  },
};

const scNoDescriptionResponse = {
  "1": {
    key: "abc123def456",
    name: "IconButton",
    id: "1",
    description: "",
  },
};

const scDescriptionResponse = {
  "1": {
    key: "abc123def456",
    name: "IconButton",
    id: "1",
    description: "A simple icon button",
  },
};
```
