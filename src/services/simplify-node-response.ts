import { SimplifiedLayout, buildSimplifiedLayout } from "~/transformers/layout.js";
import type {
  GetFileNodesResponse,
  Node as FigmaDocumentNode,
  Paint,
  Vector,
  GetFileResponse,
} from "@figma/rest-api-spec";
import { hasValue, isRectangleCornerRadii, isTruthy } from "~/utils/identity.js";
import { removeEmptyKeys, generateVarId, StyleId, parsePaint, isVisible } from "~/utils/common.js";
import { buildSimplifiedStrokes, SimplifiedStroke } from "~/transformers/style.js";
import { buildSimplifiedEffects, SimplifiedEffects } from "~/transformers/effects.js";
/**
 * TDOO ITEMS
 *
 * - Improve layout handling—translate from Figma vocabulary to CSS
 * - Pull image fills/vectors out to top level for better AI visibility
 *   ? Implement vector parents again for proper downloads
 * ? Look up existing styles in new MCP endpoint—Figma supports individual lookups without enterprise /v1/styles/:key
 * ? Parse out and save .cursor/rules/design-tokens file on command
 **/

// -------------------- SIMPLIFIED STRUCTURES --------------------

export type TextStyle = Partial<{
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  lineHeight: string;
  letterSpacing: string;
  textCase: string;
  textAlignHorizontal: string;
  textAlignVertical: string;
}>;
export type StrokeWeights = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};
type StyleTypes =
  | TextStyle
  | SimplifiedFill[]
  | SimplifiedLayout
  | SimplifiedStroke
  | SimplifiedEffects
  | string;

// Enhanced StyleInfo to include name information
export interface StyleInfo {
  name?: string;
  value: StyleTypes;
}

type GlobalVars = {
  styles: Record<StyleId, StyleTypes>;
  styleInfo?: Record<StyleId, StyleInfo>; // Added to include style name information
};

export interface SimplifiedDesign {
  name: string;
  lastModified: string;
  thumbnailUrl: string;
  nodes: SimplifiedNode[];
  globalVars: GlobalVars;
  styles?: any; // Optional field to include all available styles
}

export interface SimplifiedNode {
  id: string;
  name: string;
  type: string; // e.g. FRAME, TEXT, INSTANCE, RECTANGLE, etc.
  // geometry
  boundingBox?: BoundingBox;
  // text
  text?: string;
  textStyle?: string;
  // appearance
  fills?: string;
  styles?: string;
  strokes?: string;
  effects?: string;
  opacity?: number;
  borderRadius?: string;
  // layout & alignment
  layout?: string;
  // backgroundColor?: ColorValue; // Deprecated by Figma API
  // for rect-specific strokes, etc.
  // children
  children?: SimplifiedNode[];
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CSSRGBAColor = `rgba(${number}, ${number}, ${number}, ${number})`;
export type CSSHexColor = `#${string}`;
export type SimplifiedFill =
  | {
      type?: Paint["type"];
      hex?: string;
      rgba?: string;
      opacity?: number;
      imageRef?: string;
      scaleMode?: string;
      gradientHandlePositions?: Vector[];
      gradientStops?: {
        position: number;
        color: ColorValue | string;
      }[];
    }
  | CSSRGBAColor
  | CSSHexColor;

export interface ColorValue {
  hex: string;
  opacity: number;
}

// ---------------------- PARSING ----------------------
export function parseFigmaResponse(
  data: GetFileResponse | GetFileNodesResponse, 
  styleMap?: Record<string, any>
): SimplifiedDesign {
  const { name, lastModified, thumbnailUrl } = data;
  let nodes: FigmaDocumentNode[];
  if ("document" in data) {
    nodes = Object.values(data.document.children);
  } else {
    nodes = Object.values(data.nodes).map((n) => n.document);
  }
  
  let globalVars: GlobalVars = {
    styles: {},
    styleInfo: {}, // Initialize the styleInfo object
  };
  
  const simplifiedNodes: SimplifiedNode[] = nodes
    .filter(isVisible)
    .map((n) => parseNode(globalVars, n, undefined, styleMap))
    .filter((child) => child !== null && child !== undefined);

  const result: SimplifiedDesign = {
    name,
    lastModified,
    thumbnailUrl: thumbnailUrl || "",
    nodes: simplifiedNodes,
    globalVars,
  };
  
  // Add styles to the top level for easier access if available
  if (styleMap && Object.keys(styleMap).length > 0) {
    result.styles = styleMap;
  }
  
  return result;
}

// Helper function to find node by ID
const findNodeById = (id: string, nodes: SimplifiedNode[]): SimplifiedNode | undefined => {
  for (const node of nodes) {
    if (node?.id === id) {
      return node;
    }

    if (node?.children && node.children.length > 0) {
      const foundInChildren = findNodeById(id, node.children);
      if (foundInChildren) {
        return foundInChildren;
      }
    }
  }

  return undefined;
};

/**
 * Find or create global variables
 * @param globalVars - Global variables object
 * @param value - Value to store
 * @param prefix - Variable ID prefix
 * @param styleName - Optional style name to associate with the variable
 * @returns Variable ID
 */
function findOrCreateVar(
  globalVars: GlobalVars, 
  value: any, 
  prefix: string,
  styleName?: string
): StyleId {
  // Check if the same value already exists
  const [existingVarId] =
    Object.entries(globalVars.styles).find(
      ([_, existingValue]) => JSON.stringify(existingValue) === JSON.stringify(value),
    ) ?? [];

  if (existingVarId) {
    // If the style name is provided and not already set, add it
    if (styleName && globalVars.styleInfo && !globalVars.styleInfo[existingVarId as StyleId]?.name) {
      globalVars.styleInfo[existingVarId as StyleId] = {
        name: styleName,
        value: value
      };
    }
    return existingVarId as StyleId;
  }

  // Create a new variable if it doesn't exist
  const varId = generateVarId(prefix);
  globalVars.styles[varId] = value;
  
  // Add style name information if provided
  if (styleName && globalVars.styleInfo) {
    globalVars.styleInfo[varId] = {
      name: styleName,
      value: value
    };
  }
  
  return varId;
}

function parseNode(
  globalVars: GlobalVars,
  n: FigmaDocumentNode,
  parent?: FigmaDocumentNode,
  styleMap?: Record<string, any>
): SimplifiedNode | null {
  const { id, name, type } = n;

  const simplified: SimplifiedNode = {
    id,
    name,
    type,
  };

  // Check for style IDs in the node
  const nodeStyleIds: Record<string, string> = {};
  if (hasValue("styles", n) && typeof n.styles === "object" && n.styles) {
    // Capture style IDs used by this node for different style types
    Object.entries(n.styles).forEach(([styleType, styleId]) => {
      if (styleId && typeof styleId === 'string') {
        nodeStyleIds[styleType] = styleId;
      }
    });
  }

  // text
  if (hasValue("style", n) && Object.keys(n.style).length) {
    const style = n.style;
    const textStyle = {
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      fontSize: style.fontSize,
      lineHeight:
        style.lineHeightPx && style.fontSize
          ? `${style.lineHeightPx / style.fontSize}em`
          : undefined,
      letterSpacing:
        style.letterSpacing && style.letterSpacing !== 0 && style.fontSize
          ? `${(style.letterSpacing / style.fontSize) * 100}%`
          : undefined,
      textCase: style.textCase,
      textAlignHorizontal: style.textAlignHorizontal,
      textAlignVertical: style.textAlignVertical,
    };
    
    // Check if there's a text style ID and look it up in the styleMap
    const textStyleId = nodeStyleIds.text;
    const textStyleName = textStyleId && styleMap && styleMap[textStyleId] 
      ? styleMap[textStyleId].name 
      : undefined;
    
    simplified.textStyle = findOrCreateVar(globalVars, textStyle, "style", textStyleName);
  }

  // fills & strokes
  if (hasValue("fills", n) && Array.isArray(n.fills) && n.fills.length) {
    // const fills = simplifyFills(n.fills.map(parsePaint));
    const fills = n.fills.map(parsePaint);
    
    // Check if there's a fill style ID and look it up in the styleMap
    const fillStyleId = nodeStyleIds.fill;
    const fillStyleName = fillStyleId && styleMap && styleMap[fillStyleId] 
      ? styleMap[fillStyleId].name 
      : undefined;
    
    simplified.fills = findOrCreateVar(globalVars, fills, "fill", fillStyleName);
  }

  const strokes = buildSimplifiedStrokes(n);
  if (strokes.colors.length) {
    // Check if there's a stroke style ID and look it up in the styleMap
    const strokeStyleId = nodeStyleIds.stroke;
    const strokeStyleName = strokeStyleId && styleMap && styleMap[strokeStyleId] 
      ? styleMap[strokeStyleId].name 
      : undefined;
    
    simplified.strokes = findOrCreateVar(globalVars, strokes, "stroke", strokeStyleName);
  }

  const effects = buildSimplifiedEffects(n);
  if (Object.keys(effects).length) {
    // Check if there's an effect style ID and look it up in the styleMap
    const effectStyleId = nodeStyleIds.effect;
    const effectStyleName = effectStyleId && styleMap && styleMap[effectStyleId] 
      ? styleMap[effectStyleId].name 
      : undefined;
    
    simplified.effects = findOrCreateVar(globalVars, effects, "effect", effectStyleName);
  }

  // Process layout
  const layout = buildSimplifiedLayout(n, parent);
  if (Object.keys(layout).length > 1) {
    // Check if there's a grid style ID and look it up in the styleMap
    const gridStyleId = nodeStyleIds.grid;
    const gridStyleName = gridStyleId && styleMap && styleMap[gridStyleId] 
      ? styleMap[gridStyleId].name 
      : undefined;
    
    simplified.layout = findOrCreateVar(globalVars, layout, "layout", gridStyleName);
  }

  // Keep other simple properties directly
  if (hasValue("characters", n, isTruthy)) {
    simplified.text = n.characters;
  }

  // border/corner
  if (hasValue("cornerRadius", n) && typeof (n as any).cornerRadius === "number" && (n as any).cornerRadius !== 0) {
    simplified.borderRadius = `${(n as any).cornerRadius}px`;
  } else if (hasValue("cornerRadius", n) && isRectangleCornerRadii((n as any).cornerRadius)) {
    const { topLeft, topRight, bottomRight, bottomLeft } = (n as any).cornerRadius;
    simplified.borderRadius = `${topLeft}px ${topRight}px ${bottomRight}px ${bottomLeft}px`;
  }

  // opacity
  if (hasValue("opacity", n) && typeof n.opacity === "number" && n.opacity !== 1) {
    simplified.opacity = n.opacity;
  }

  // Handle children recursively
  if (hasValue("children", n) && Array.isArray(n.children) && n.children.length) {
    let children = n.children
      .filter(isVisible)
      .map((child) => parseNode(globalVars, child, n, styleMap))
      .filter((child) => child !== null && child !== undefined);
    if (children.length) {
      simplified.children = children as SimplifiedNode[];
    }
  }

  // Convert VECTOR to IMAGE
  if (type === "VECTOR") {
    simplified.type = "IMAGE-SVG";
  }

  return removeEmptyKeys(simplified);
}
