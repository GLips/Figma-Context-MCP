import { type SimplifiedLayout, buildSimplifiedLayout } from "~/transformers/layout.js";
import type {
  GetFileNodesResponse,
  Node as FigmaDocumentNode,
  Paint,
  Vector,
  GetFileResponse,
  Component,
  ComponentSet,
} from "@figma/rest-api-spec";
import type {
  SimplifiedComponentDefinition,
  SimplifiedComponentSetDefinition,
} from "~/utils/sanitization.js";
import { sanitizeComponents, sanitizeComponentSets } from "~/utils/sanitization.js";
import { getNodeCategory, hasValue, isRectangleCornerRadii, isTruthy } from "~/utils/identity.js";
import {
  removeEmptyKeys,
  generateVarId,
  type StyleId,
  parsePaint,
  isVisible,
} from "~/utils/common.js";
import { buildSimplifiedStrokes, type SimplifiedStroke } from "~/transformers/style.js";
import { buildSimplifiedEffects, type SimplifiedEffects } from "~/transformers/effects.js";
import { buildSimplifiedIcon, type SimpledIcon } from "~/transformers/icon.js";

/**
 * TODO ITEMS
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
type GlobalVars = {
  styles: Record<StyleId, StyleTypes>;
  icons: Record<string, SimpledIcon>;
};

export interface SimplifiedDesign {
  name: string;
  lastModified: string;
  thumbnailUrl: string;
  nodes: SimplifiedNode[];
  components: Record<string, SimplifiedComponentDefinition>;
  componentSets: Record<string, SimplifiedComponentSetDefinition>;
  globalVars: GlobalVars;
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
  componentId?: string;
  componentProperties?: Record<string, any>;
  icon?: string;
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
export async function parseFigmaResponse(
  fileKey: string,
  data: GetFileResponse | GetFileNodesResponse,
): Promise<SimplifiedDesign> {
  const aggregatedComponents: Record<string, Component> = {};
  const aggregatedComponentSets: Record<string, ComponentSet> = {};
  let nodesToParse: Array<FigmaDocumentNode>;

  if ("nodes" in data) {
    // GetFileNodesResponse
    const nodeResponses = Object.values(data.nodes); // Compute once
    nodeResponses.forEach((nodeResponse) => {
      if (nodeResponse.components) {
        Object.assign(aggregatedComponents, nodeResponse.components);
      }
      if (nodeResponse.componentSets) {
        Object.assign(aggregatedComponentSets, nodeResponse.componentSets);
      }
    });
    nodesToParse = nodeResponses.map((n) => n.document);
  } else {
    // GetFileResponse
    Object.assign(aggregatedComponents, data.components);
    Object.assign(aggregatedComponentSets, data.componentSets);
    nodesToParse = data.document.children;
  }

  const sanitizedComponents = sanitizeComponents(aggregatedComponents);
  const sanitizedComponentSets = sanitizeComponentSets(aggregatedComponentSets);

  const { name, lastModified, thumbnailUrl } = data;

  const globalVars: GlobalVars = {
    styles: {},
    icons: {},
  };

  const visibleNodes = nodesToParse.filter(isVisible);
  let simplifiedNodes = [];
  for (const n of visibleNodes) {
    const parsedNode = await parseNode(fileKey, globalVars, n);
    simplifiedNodes.push(parsedNode);
  }
  simplifiedNodes = simplifiedNodes.filter((child) => child !== null && child !== undefined);

  const simplifiedDesign: SimplifiedDesign = {
    name,
    lastModified,
    thumbnailUrl: thumbnailUrl || "",
    nodes: simplifiedNodes,
    components: sanitizedComponents,
    componentSets: sanitizedComponentSets,
    globalVars,
  };

  return removeEmptyKeys(simplifiedDesign);
}

/**
 * Find or create global variables
 * @param globalVars - Global variables object
 * @param value - Value to store
 * @param prefix - Variable ID prefix
 * @returns Variable ID
 */
function findOrCreateVar(globalVars: GlobalVars, value: any, prefix: string): StyleId {
  // Check if the same value already exists
  const [existingVarId] =
    Object.entries(globalVars.styles).find(
      ([_, existingValue]) => JSON.stringify(existingValue) === JSON.stringify(value),
    ) ?? [];

  if (existingVarId) {
    return existingVarId as StyleId;
  }

  // Create a new variable if it doesn't exist
  const varId = generateVarId(prefix);
  globalVars.styles[varId] = value;
  return varId;
}

/**
 * Find or create a global variable for an icon
 *
 * @param icon - Icon object containing fileName and other properties
 * @param globalVars - Global variables object to store icons
 * @returns The fileName of the icon
 */
function findOrCreateVarForIcons(icon: SimpledIcon, globalVars: GlobalVars): string {
  const { fileName } = icon;
  globalVars.icons = globalVars.icons ?? {};
  const isExist = Object.keys(globalVars.icons).findIndex((key) => key === icon.fileName) !== -1;
  if (!isExist) {
    globalVars.icons[fileName] = icon;
  }
  return fileName;
}

async function parseNode(
  fileKey: string,
  globalVars: GlobalVars,
  n: FigmaDocumentNode,
  parent?: FigmaDocumentNode,
): Promise<SimplifiedNode | null> {
  const { id, name, type } = n;

  const simplified: SimplifiedNode = {
    id,
    name,
    type,
  };

  // Determine the category of the node
  const category = getNodeCategory(n);
  if (category === "component") {
    if (type === "INSTANCE") {
      if (hasValue("componentId", n)) {
        simplified.componentId = n.componentId;
      }
      if (hasValue("componentProperties", n)) {
        simplified.componentProperties = n.componentProperties;
      }
    }
  } else if (category === "icon") {
    const icon = await buildSimplifiedIcon(fileKey, n);
    if (icon) {
      simplified.icon = findOrCreateVarForIcons(icon, globalVars);
    }
  }

  // text
  if (hasValue("style", n) && Object.keys(n.style).length) {
    const style = n.style;
    const textStyle: TextStyle = {
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
    simplified.textStyle = findOrCreateVar(globalVars, textStyle, "style");
  }

  // fills & strokes
  if (hasValue("fills", n) && Array.isArray(n.fills) && n.fills.length) {
    // const fills = simplifyFills(n.fills.map(parsePaint));
    const fills = n.fills.map(parsePaint);
    simplified.fills = findOrCreateVar(globalVars, fills, "fill");
  }

  const strokes = buildSimplifiedStrokes(n);
  if (strokes.colors.length) {
    simplified.strokes = findOrCreateVar(globalVars, strokes, "stroke");
  }

  const effects = buildSimplifiedEffects(n);
  if (Object.keys(effects).length) {
    simplified.effects = findOrCreateVar(globalVars, effects, "effect");
  }

  // Process layout
  const layout = buildSimplifiedLayout(n, parent);
  if (Object.keys(layout).length > 1) {
    simplified.layout = findOrCreateVar(globalVars, layout, "layout");
  }

  // Keep other simple properties directly
  if (hasValue("characters", n, isTruthy)) {
    simplified.text = n.characters;
  }

  // border/corner

  // opacity
  if (hasValue("opacity", n) && typeof n.opacity === "number" && n.opacity !== 1) {
    simplified.opacity = n.opacity;
  }

  if (hasValue("cornerRadius", n) && typeof n.cornerRadius === "number") {
    simplified.borderRadius = `${n.cornerRadius}px`;
  }
  if (hasValue("rectangleCornerRadii", n, isRectangleCornerRadii)) {
    simplified.borderRadius = `${n.rectangleCornerRadii[0]}px ${n.rectangleCornerRadii[1]}px ${n.rectangleCornerRadii[2]}px ${n.rectangleCornerRadii[3]}px`;
  }

  // Recursively process child nodes
  if (hasValue("children", n) && shouldTraverseChildren(n, simplified)) {
    const visibleNodes = n.children.filter(isVisible);
    let simplifiedNodes = [];
    for (const visibleNode of visibleNodes) {
      const parsedNode = await parseNode(fileKey, globalVars, visibleNode, n);
      simplifiedNodes.push(parsedNode);
    }
    simplifiedNodes = simplifiedNodes.filter((child) => child !== null && child !== undefined);

    if (simplifiedNodes.length) {
      simplified.children = simplifiedNodes;
    }
  }

  return simplified;
}

/**
 * Determines whether to traverse the children of a Figma node
 *
 * @param n - The Figma node to evaluate
 * @param simplifiedParent - The simplified parent node containing metadata like icon classification
 * @returns True if the node's children should be traversed, false otherwise
 */
function shouldTraverseChildren(n: FigmaDocumentNode, simplifiedParent: SimplifiedNode): boolean {
  // If a node has a determined classification (e.g., icon or component), its type alone
  // provides enough information to generate code, and traversing children is unnecessary.
  return (
    hasValue("children", n) &&
    Array.isArray(n.children) &&
    n.children.length > 0 &&
    !simplifiedParent.icon
  );
}
