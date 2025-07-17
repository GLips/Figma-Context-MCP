# Flexible Figma Data Extractors

This module provides a flexible, single-pass system for extracting data from Figma design files. It allows you to compose different extractors based on your specific needs, making it perfect for different LLM use cases where you want to optimize context window usage.

## Architecture

The system is built in clean layers:

1. **Strategy Layer**: Define what you want to extract
2. **Traversal Layer**: Single-pass tree walking with configurable extractors
3. **Extraction Layer**: Pure functions that transform individual node data

## Basic Usage

```typescript
import { extractFromDesign, allExtractors, layoutAndText, contentOnly } from "figma-mcp/extractors";

// Extract everything (equivalent to current parseNode)
const fullData = extractFromDesign(nodes, allExtractors);

// Extract only layout + text for content planning
const layoutData = extractFromDesign(nodes, layoutAndText, {
  maxDepth: 3,
});

// Extract only text content for copy audits
const textData = extractFromDesign(nodes, contentOnly, {
  nodeFilter: (node) => node.type === "TEXT",
});
```

## Built-in Extractors

### Individual Extractors

- `layoutExtractor` - Layout properties (positioning, sizing, flex properties)
- `textExtractor` - Text content and typography styles
- `visualsExtractor` - Visual appearance (fills, strokes, effects, opacity, borders)
- `componentExtractor` - Component instance data

### Convenience Combinations

- `allExtractors` - Everything (replicates current behavior)
- `layoutAndText` - Layout + text (good for content analysis)
- `contentOnly` - Text only (good for copy extraction)
- `visualsOnly` - Visual styles only (good for design systems)
- `layoutOnly` - Layout only (good for structure analysis)

## Creating Custom Extractors

```typescript
import type { ExtractorFn } from "figma-mcp/extractors";

// Custom extractor that identifies design system components
const designSystemExtractor: ExtractorFn = (node, result, context) => {
  if (node.name.startsWith("DS/")) {
    result.isDesignSystemComponent = true;
    result.dsCategory = node.name.split("/")[1];
  }
};

// Use it with other extractors
const data = extractFromDesign(nodes, [layoutExtractor, designSystemExtractor]);
```

## Filtering and Options

```typescript
// Limit traversal depth
const shallowData = extractFromDesign(nodes, allExtractors, {
  maxDepth: 2,
});

// Filter to specific node types
const frameData = extractFromDesign(nodes, layoutAndText, {
  nodeFilter: (node) => ["FRAME", "GROUP"].includes(node.type),
});

// Custom filtering logic
const buttonData = extractFromDesign(nodes, allExtractors, {
  nodeFilter: (node) => node.name.toLowerCase().includes("button"),
});
```

## LLM Context Optimization

The flexible system is designed for different LLM use cases:

```typescript
// For large designs - extract incrementally
function extractForLLM(nodes, phase) {
  switch (phase) {
    case "structure":
      return extractFromDesign(nodes, layoutOnly, { maxDepth: 3 });

    case "content":
      return extractFromDesign(nodes, contentOnly);

    case "styling":
      return extractFromDesign(nodes, visualsOnly, { maxDepth: 2 });

    case "full":
      return extractFromDesign(nodes, allExtractors);
  }
}
```

## Benefits

1. **Single Tree Walk** - Efficient processing, no matter how many extractors
2. **Composable** - Mix and match extractors for your specific needs
3. **Extensible** - Easy to add custom extractors for domain-specific logic
4. **Type Safe** - Full TypeScript support with proper inference
5. **Context Optimized** - Perfect for LLM context window management
6. **Backward Compatible** - Works alongside existing parsing logic

## Migration Path

The new system works alongside the current `parseNode` function. You can:

1. Start using the new extractors for new use cases
2. Gradually migrate existing functionality
3. Keep the current API for general-purpose parsing

The `allExtractors` combination provides equivalent functionality to the current `parseNode` behavior.
