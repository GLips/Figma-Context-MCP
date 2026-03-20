/**
 * XML Serializer for Figma node metadata
 * Converts Figma node trees to sparse XML representation
 */

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  absoluteBoundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  visible?: boolean;
}

/**
 * Escapes XML special characters in text content
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Serializes a single node to XML
 */
function serializeNode(node: FigmaNode, indent: string = ""): string {
  const { id, name, type, children, absoluteBoundingBox, visible } = node;

  // Build attributes
  const attrs: string[] = [
    `id="${escapeXml(id)}"`,
    `type="${escapeXml(type)}"`,
    `name="${escapeXml(name)}"`,
  ];

  // Add bounding box if present
  if (absoluteBoundingBox) {
    const { x, y, width, height } = absoluteBoundingBox;
    attrs.push(`x="${x.toFixed(2)}"`);
    attrs.push(`y="${y.toFixed(2)}"`);
    attrs.push(`width="${width.toFixed(2)}"`);
    attrs.push(`height="${height.toFixed(2)}"`);
  }

  // Add visibility if explicitly false
  if (visible === false) {
    attrs.push(`visible="false"`);
  }

  const attrString = attrs.join(" ");

  // Self-closing tag if no children
  if (!children || children.length === 0) {
    return `${indent}<node ${attrString} />`;
  }

  // Opening tag with children
  const lines: string[] = [`${indent}<node ${attrString}>`];

  // Serialize children recursively
  for (const child of children) {
    lines.push(serializeNode(child, indent + "  "));
  }

  // Closing tag
  lines.push(`${indent}</node>`);

  return lines.join("\n");
}

/**
 * Converts a Figma node tree to XML representation
 * @param node - Root node or node tree to serialize
 * @param includeXmlDeclaration - Whether to include XML declaration header
 * @returns XML string representation
 */
export function nodeToXml(node: FigmaNode, includeXmlDeclaration: boolean = true): string {
  const xmlDeclaration = '<?xml version="1.0" encoding="UTF-8"?>';
  const serialized = serializeNode(node);

  return includeXmlDeclaration ? `${xmlDeclaration}\n${serialized}` : serialized;
}

/**
 * Converts multiple Figma nodes to XML representation
 * @param nodes - Array of nodes to serialize
 * @param rootName - Name for the root wrapper element
 * @param includeXmlDeclaration - Whether to include XML declaration header
 * @returns XML string representation
 */
export function nodesToXml(
  nodes: FigmaNode[],
  rootName: string = "nodes",
  includeXmlDeclaration: boolean = true,
): string {
  const xmlDeclaration = '<?xml version="1.0" encoding="UTF-8"?>';
  const lines: string[] = [`<${rootName}>`];

  for (const node of nodes) {
    lines.push(serializeNode(node, "  "));
  }

  lines.push(`</${rootName}>`);

  const serialized = lines.join("\n");
  return includeXmlDeclaration ? `${xmlDeclaration}\n${serialized}` : serialized;
}

/**
 * Extracts sparse metadata from raw Figma API response
 * Simplifies node structure to only essential properties
 */
export function extractSparseMetadata(rawNode: any): FigmaNode {
  const node: FigmaNode = {
    id: rawNode.id,
    name: rawNode.name,
    type: rawNode.type,
  };

  // Add bounding box if present
  if (rawNode.absoluteBoundingBox) {
    node.absoluteBoundingBox = {
      x: rawNode.absoluteBoundingBox.x,
      y: rawNode.absoluteBoundingBox.y,
      width: rawNode.absoluteBoundingBox.width,
      height: rawNode.absoluteBoundingBox.height,
    };
  }

  // Add visibility if explicitly false
  if (rawNode.visible === false) {
    node.visible = false;
  }

  // Recursively process children
  if (rawNode.children && Array.isArray(rawNode.children)) {
    node.children = rawNode.children.map(extractSparseMetadata);
  }

  return node;
}
