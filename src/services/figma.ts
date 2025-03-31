import fs from "fs";
import { parseFigmaResponse, SimplifiedDesign } from "./simplify-node-response.js";
import type {
  GetImagesResponse,
  GetFileResponse,
  GetFileNodesResponse,
  GetImageFillsResponse,
} from "@figma/rest-api-spec";
import { downloadFigmaImage } from "~/utils/common.js";
import { Logger } from "~/server.js";

export interface FigmaError {
  status: number;
  err: string;
}

type FetchImageParams = {
  /**
   * The Node in Figma that will either be rendered or have its background image downloaded
   */
  nodeId: string;
  /**
   * The local file name to save the image
   */
  fileName: string;
  /**
   * The file mimetype for the image
   */
  fileType: "png" | "svg";
};

type FetchImageFillParams = Omit<FetchImageParams, "fileType"> & {
  /**
   * Required to grab the background image when an image is used as a fill
   */
  imageRef: string;
};

// Define types for Figma style objects
export interface FigmaStyle {
  key: string;
  name: string;
  description: string;
  style_type: "FILL" | "TEXT" | "EFFECT" | "GRID";
}

// Style detail interfaces for different style types
export interface FigmaStyleDetails extends FigmaStyle {
  node_id: string;
  created_at: string;
  updated_at: string;
  user: {
    id: string;
    handle: string;
    name: string;
  };
  file_key: string;
  description: string;
}

export interface FigmaPaintStyleDetails extends FigmaStyleDetails {
  style_type: "FILL";
  paints: Array<any>; // Detailed paint information
}

export interface FigmaTextStyleDetails extends FigmaStyleDetails {
  style_type: "TEXT";
  font_family: string;
  font_style: string;
  font_weight: number;
  font_size: number;
  line_height?: any;
  letter_spacing?: any;
  text_case?: string;
  text_decoration?: string;
  text_align_horizontal?: string;
  text_align_vertical?: string;
  paragraph_spacing?: number;
  paragraph_indent?: number;
  is_italic?: boolean;
}

export interface FigmaEffectStyleDetails extends FigmaStyleDetails {
  style_type: "EFFECT";
  effects: Array<any>; // Detailed effect information
}

export interface FigmaGridStyleDetails extends FigmaStyleDetails {
  style_type: "GRID";
  grids: Array<any>; // Detailed grid information
}

export interface GetStylesResponse {
  meta: {
    styles: Record<string, FigmaStyle>;
  };
}

export interface StyleToNodeMapping {
  styleId: string;
  styleName: string;
  styleType: "FILL" | "TEXT" | "EFFECT" | "GRID";
  nodeIds: string[];
  value: any; // Actual style value (color, text properties, etc.)
}

export interface StyleToNodeMappingResult {
  fillStyles: Record<string, StyleToNodeMapping>;
  textStyles: Record<string, StyleToNodeMapping>;
  effectStyles: Record<string, StyleToNodeMapping>;
  gridStyles: Record<string, StyleToNodeMapping>;
}

// Style usage tracking interface
export interface StyleUsageMap {
  fillStyleIds: Record<string, string[]>; // Maps style ID to node IDs that use it
  textStyleIds: Record<string, string[]>;
  effectStyleIds: Record<string, string[]>;
  gridStyleIds: Record<string, string[]>;
}

// New interface to store style name and value mapping
export interface StyleNameValueMapping {
  name: string;
  value: any;
}

// New interface for enhanced global vars
export interface EnhancedGlobalVars {
  styles: Record<string, any>;
  styleInfo: Record<string, StyleNameValueMapping>;
}

export class FigmaService {
  private readonly apiKey: string;
  private readonly baseUrl = "https://api.figma.com/v1";
  // Cache for style information to reduce API calls
  private styleCache: Record<string, Record<string, FigmaStyle>> = {};

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request<T>(endpoint: string): Promise<T> {
    if (typeof fetch !== "function") {
      throw new Error(
        "The MCP server is being run in a Node.js environment where `fetch` is not available. You won't be able to access any data related to the Figma file.\n\nAs the coding AI assistant, PLEASE ABORT THE CURRENT REQUEST. No alternate approaches will work. Help the user fix this issue so you can proceed by letting them know that they need to run the MCP server with Node.js version 18 or higher.",
      );
    }
    try {
      Logger.log(`Calling ${this.baseUrl}${endpoint}`);
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        headers: {
          "X-Figma-Token": this.apiKey,
        },
      });

      if (!response.ok) {
        throw {
          status: response.status,
          err: response.statusText || "Unknown error",
        } as FigmaError;
      }

      return await response.json();
    } catch (error) {
      if ((error as FigmaError).status) {
        throw error;
      }
      if (error instanceof Error) {
        throw new Error(`Failed to make request to Figma API: ${error.message}`);
      }
      throw new Error(`Failed to make request to Figma API: ${error}`);
    }
  }

  async getImageFills(
    fileKey: string,
    nodes: FetchImageFillParams[],
    localPath: string,
  ): Promise<string[]> {
    if (nodes.length === 0) return [];

    let promises: Promise<string>[] = [];
    const endpoint = `/files/${fileKey}/images`;
    const file = await this.request<GetImageFillsResponse>(endpoint);
    const { images = {} } = file.meta;
    promises = nodes.map(async ({ imageRef, fileName }) => {
      const imageUrl = images[imageRef];
      if (!imageUrl) {
        return "";
      }
      return downloadFigmaImage(fileName, localPath, imageUrl);
    });
    return Promise.all(promises);
  }

  async getImages(
    fileKey: string,
    nodes: FetchImageParams[],
    localPath: string,
  ): Promise<string[]> {
    const pngIds = nodes.filter(({ fileType }) => fileType === "png").map(({ nodeId }) => nodeId);
    const pngFiles =
      pngIds.length > 0
        ? this.request<GetImagesResponse>(
            `/images/${fileKey}?ids=${pngIds.join(",")}&scale=2&format=png`,
          ).then(({ images = {} }) => images)
        : ({} as GetImagesResponse["images"]);

    const svgIds = nodes.filter(({ fileType }) => fileType === "svg").map(({ nodeId }) => nodeId);
    const svgFiles =
      svgIds.length > 0
        ? this.request<GetImagesResponse>(
            `/images/${fileKey}?ids=${svgIds.join(",")}&scale=2&format=svg`,
          ).then(({ images = {} }) => images)
        : ({} as GetImagesResponse["images"]);

    const files = await Promise.all([pngFiles, svgFiles]).then(([f, l]) => ({ ...f, ...l }));

    const downloads = nodes
      .map(({ nodeId, fileName }) => {
        const imageUrl = files[nodeId];
        if (imageUrl) {
          return downloadFigmaImage(fileName, localPath, imageUrl);
        }
        return false;
      })
      .filter((url) => !!url);

    return Promise.all(downloads);
  }

  async getFile(fileKey: string, depth?: number): Promise<SimplifiedDesign> {
    try {
      const endpoint = `/files/${fileKey}${depth ? `?depth=${depth}` : ""}`;
      Logger.log(`Retrieving Figma file: ${fileKey} (depth: ${depth ?? "default"})`);
      const response = await this.request<GetFileResponse>(endpoint);
      Logger.log("Got response");
      
      // Load style information for the file to enhance the response
      await this.loadStylesIntoCache(fileKey);
      
      const simplifiedResponse = parseFigmaResponse(response, this.styleCache[fileKey]);
      writeLogs("figma-raw.json", response);
      writeLogs("figma-simplified.json", simplifiedResponse);
      return simplifiedResponse;
    } catch (e) {
      console.error("Failed to get file:", e);
      throw e;
    }
  }

  async getNode(fileKey: string, nodeId: string, depth?: number): Promise<SimplifiedDesign> {
    const endpoint = `/files/${fileKey}/nodes?ids=${nodeId}${depth ? `&depth=${depth}` : ""}`;
    const response = await this.request<GetFileNodesResponse>(endpoint);
    Logger.log("Got response from getNode, now parsing.");
    
    // Load style information for the file to enhance the response
    await this.loadStylesIntoCache(fileKey);
    
    writeLogs("figma-raw.json", response);
    const simplifiedResponse = parseFigmaResponse(response, this.styleCache[fileKey]);
    writeLogs("figma-simplified.json", simplifiedResponse);
    return simplifiedResponse;
  }

  // Helper method to load styles into cache
  private async loadStylesIntoCache(fileKey: string): Promise<void> {
    if (!this.styleCache[fileKey]) {
      try {
        const styles = await this.getStyles(fileKey);
        
        // Create a unified style map for easier access
        const styleMap: Record<string, FigmaStyle> = {};
        
        // Add all styles to the map
        [...styles.paintStyles, ...styles.textStyles, ...styles.effectStyles, ...styles.gridStyles].forEach(style => {
          styleMap[style.key] = style;
        });
        
        this.styleCache[fileKey] = styleMap;
        Logger.log(`Cached ${Object.keys(styleMap).length} styles for file ${fileKey}`);
      } catch (error) {
        Logger.error(`Failed to load styles for file ${fileKey}:`, error);
        // Initialize with empty object if styles can't be loaded
        this.styleCache[fileKey] = {};
      }
    }
  }

  /**
   * Fetches all styles defined in a Figma file
   * @param fileKey The ID of the Figma file to fetch styles from
   * @returns Promise resolving to an object containing different style types
   */
  async getStyles(fileKey: string): Promise<{
    paintStyles: FigmaStyle[];
    textStyles: FigmaStyle[];
    effectStyles: FigmaStyle[];
    gridStyles: FigmaStyle[];
  }> {
    try {
      const endpoint = `/files/${fileKey}/styles`;
      Logger.log(`Retrieving styles from Figma file: ${fileKey}`);
      const response = await this.request<GetStylesResponse>(endpoint);
      
      // Organize styles by type
      const stylesByType = {
        paintStyles: [] as FigmaStyle[],
        textStyles: [] as FigmaStyle[],
        effectStyles: [] as FigmaStyle[],
        gridStyles: [] as FigmaStyle[]
      };

      if (response && response.meta && response.meta.styles) {
        for (const styleId in response.meta.styles) {
          const style = response.meta.styles[styleId];
          switch (style.style_type) {
            case "FILL":
              stylesByType.paintStyles.push(style);
              break;
            case "TEXT":
              stylesByType.textStyles.push(style);
              break;
            case "EFFECT":
              stylesByType.effectStyles.push(style);
              break;
            case "GRID":
              stylesByType.gridStyles.push(style);
              break;
          }
        }
      }

      writeLogs("figma-styles.json", stylesByType);
      return stylesByType;
    } catch (e) {
      console.error("Failed to get styles:", e);
      throw e;
    }
  }

  /**
   * Fetches details of a specific style
   * @param styleKey The key of the style to fetch
   * @returns Promise resolving to the detailed style information
   */
  async getStyleDetails(styleKey: string): Promise<FigmaStyleDetails> {
    try {
      const endpoint = `/styles/${styleKey}`;
      Logger.log(`Retrieving style details for: ${styleKey}`);
      const response = await this.request<FigmaStyleDetails>(endpoint);
      writeLogs(`figma-style-${styleKey}.json`, response);
      return response;
    } catch (e) {
      console.error("Failed to get style details:", e);
      throw e;
    }
  }

  /**
   * Fetches details for a batch of styles
   * @param styleKeys Array of style keys to fetch details for
   * @returns Promise resolving to an object with style keys mapped to their details
   */
  async getMultipleStyleDetails(styleKeys: string[]): Promise<Record<string, FigmaStyleDetails>> {
    try {
      const promises = styleKeys.map(key => this.getStyleDetails(key));
      const styleDetails = await Promise.all(promises);
      
      const stylesMap: Record<string, FigmaStyleDetails> = {};
      styleDetails.forEach(detail => {
        stylesMap[detail.key] = detail;
      });
      
      return stylesMap;
    } catch (e) {
      console.error("Failed to get multiple style details:", e);
      throw e;
    }
  }

  /**
   * Maps local styles to nodes that use them.
   * This improved version provides detailed style information along with style usage.
   */
  async mapNodesToLocalStyles(fileKey: string, nodeId?: string): Promise<StyleToNodeMappingResult> {
    try {
      // Get style usage map
      const styleUsage = await this.detectStyleUsage(fileKey, nodeId);
      
      // Get all styles from the file
      const allStyles = await this.getStyles(fileKey);
      
      // Create maps for each style type
      const paintStyleMap = new Map(allStyles.paintStyles.map(s => [s.key, s]));
      const textStyleMap = new Map(allStyles.textStyles.map(s => [s.key, s]));
      const effectStyleMap = new Map(allStyles.effectStyles.map(s => [s.key, s]));
      const gridStyleMap = new Map(allStyles.gridStyles.map(s => [s.key, s]));
      
      // Get all style IDs used in the file
      const usedStyleIds = [
        ...Object.keys(styleUsage.fillStyleIds),
        ...Object.keys(styleUsage.textStyleIds),
        ...Object.keys(styleUsage.effectStyleIds),
        ...Object.keys(styleUsage.gridStyleIds)
      ];
      
      // Get detailed style information for all used styles
      const styleDetails = await this.getMultipleStyleDetails(usedStyleIds);
      
      // Create the result object
      const result: StyleToNodeMappingResult = {
        fillStyles: {},
        textStyles: {},
        effectStyles: {},
        gridStyles: {}
      };
      
      // Process fill styles
      for (const [styleId, nodeIds] of Object.entries(styleUsage.fillStyleIds)) {
        const style = paintStyleMap.get(styleId);
        if (style) {
          const details = styleDetails[styleId] as FigmaPaintStyleDetails;
          const styleValue = details ? this.extractFillStyleValue(details) : undefined;
          
          result.fillStyles[styleId] = {
            styleId,
            styleName: style.name,
            styleType: 'FILL',
            nodeIds,
            value: styleValue
          };
        }
      }
      
      // Process text styles
      for (const [styleId, nodeIds] of Object.entries(styleUsage.textStyleIds)) {
        const style = textStyleMap.get(styleId);
        if (style) {
          const details = styleDetails[styleId] as FigmaTextStyleDetails;
          const styleValue = details ? this.extractTextStyleValue(details) : undefined;
          
          result.textStyles[styleId] = {
            styleId,
            styleName: style.name,
            styleType: 'TEXT',
            nodeIds,
            value: styleValue
          };
        }
      }
      
      // Process effect styles
      for (const [styleId, nodeIds] of Object.entries(styleUsage.effectStyleIds)) {
        const style = effectStyleMap.get(styleId);
        if (style) {
          const details = styleDetails[styleId] as FigmaEffectStyleDetails;
          const styleValue = details ? this.extractEffectStyleValue(details) : undefined;
          
          result.effectStyles[styleId] = {
            styleId,
            styleName: style.name,
            styleType: 'EFFECT',
            nodeIds,
            value: styleValue
          };
        }
      }
      
      // Process grid styles
      for (const [styleId, nodeIds] of Object.entries(styleUsage.gridStyleIds)) {
        const style = gridStyleMap.get(styleId);
        if (style) {
          const details = styleDetails[styleId] as FigmaGridStyleDetails;
          const styleValue = details ? this.extractGridStyleValue(details) : undefined;
          
          result.gridStyles[styleId] = {
            styleId,
            styleName: style.name,
            styleType: 'GRID',
            nodeIds,
            value: styleValue
          };
        }
      }
      
      return result;
    } catch (error) {
      console.error("Error mapping nodes to local styles:", error);
      return {
        fillStyles: {},
        textStyles: {},
        effectStyles: {},
        gridStyles: {}
      };
    }
  }
  
  /**
   * Helper method to extract usable fill style values from style details
   * @param styleDetails The fill style details to extract values from
   * @returns Extracted fill style values in a more usable format
   */
  private extractFillStyleValue(styleDetails: FigmaPaintStyleDetails): any {
    if (!styleDetails.paints || styleDetails.paints.length === 0) {
      return null;
    }
    
    // For simplicity, we'll just return the first paint's value
    // You can enhance this to handle multiple paints if needed
    const paint = styleDetails.paints[0];
    
    if (paint.type === "SOLID" && paint.color) {
      // Convert RGBA to hex
      const r = Math.round(paint.color.r * 255);
      const g = Math.round(paint.color.g * 255);
      const b = Math.round(paint.color.b * 255);
      const a = paint.color.a;
      
      const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
      
      return {
        type: "SOLID",
        color: {
          hex,
          rgba: { r, g, b, a }
        },
        opacity: paint.opacity ?? 1
      };
    } else if (paint.type === "GRADIENT_LINEAR" || paint.type === "GRADIENT_RADIAL" || paint.type === "GRADIENT_ANGULAR") {
      // Return gradient information
      return {
        type: paint.type,
        gradientStops: paint.gradientStops?.map((stop: any) => {
          const r = Math.round(stop.color.r * 255);
          const g = Math.round(stop.color.g * 255);
          const b = Math.round(stop.color.b * 255);
          const a = stop.color.a;
          
          const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
          
          return {
            position: stop.position,
            color: {
              hex,
              rgba: { r, g, b, a }
            }
          };
        }),
        opacity: paint.opacity ?? 1
      };
    } else {
      // For image fills, patterns, etc.
      return {
        type: paint.type,
        opacity: paint.opacity ?? 1
      };
    }
  }
  
  /**
   * Helper method to extract usable text style values from style details
   * @param styleDetails The text style details to extract values from
   * @returns Extracted text style values in a more usable format
   */
  private extractTextStyleValue(styleDetails: FigmaTextStyleDetails): any {
    return {
      fontFamily: styleDetails.font_family,
      fontSize: styleDetails.font_size,
      fontWeight: styleDetails.font_weight,
      fontStyle: styleDetails.font_style,
      lineHeight: styleDetails.line_height,
      letterSpacing: styleDetails.letter_spacing,
      textCase: styleDetails.text_case,
      textDecoration: styleDetails.text_decoration,
      paragraphSpacing: styleDetails.paragraph_spacing,
      paragraphIndent: styleDetails.paragraph_indent,
      isItalic: styleDetails.is_italic,
      textAlignHorizontal: styleDetails.text_align_horizontal,
      textAlignVertical: styleDetails.text_align_vertical
    };
  }
  
  /**
   * Helper method to extract usable effect style values from style details
   * @param styleDetails The effect style details to extract values from
   * @returns Extracted effect style values in a more usable format
   */
  private extractEffectStyleValue(styleDetails: FigmaEffectStyleDetails): any {
    if (!styleDetails.effects || styleDetails.effects.length === 0) {
      return null;
    }
    
    return styleDetails.effects.map(effect => {
      const result: any = {
        type: effect.type,
        visible: effect.visible
      };
      
      if (effect.radius !== undefined) {
        result.radius = effect.radius;
      }
      
      if (effect.spread !== undefined) {
        result.spread = effect.spread;
      }
      
      if (effect.color) {
        const r = Math.round(effect.color.r * 255);
        const g = Math.round(effect.color.g * 255);
        const b = Math.round(effect.color.b * 255);
        const a = effect.color.a;
        
        const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
        
        result.color = {
          hex,
          rgba: { r, g, b, a }
        };
      }
      
      if (effect.offset) {
        result.offset = effect.offset;
      }
      
      if (effect.blendMode !== undefined) {
        result.blendMode = effect.blendMode;
      }
      
      if (effect.showShadowBehindNode !== undefined) {
        result.showShadowBehindNode = effect.showShadowBehindNode;
      }
      
      return result;
    });
  }
  
  /**
   * Helper method to extract usable grid style values from style details
   * @param styleDetails The grid style details to extract values from
   * @returns Extracted grid style values in a more usable format
   */
  private extractGridStyleValue(styleDetails: FigmaGridStyleDetails): any {
    if (!styleDetails.grids || styleDetails.grids.length === 0) {
      return null;
    }
    
    return styleDetails.grids.map(grid => {
      const result: any = {
        pattern: grid.pattern,
        visible: grid.visible,
        alignment: grid.alignment,
        gutterSize: grid.gutterSize,
        count: grid.count
      };
      
      if (grid.color) {
        const r = Math.round(grid.color.r * 255);
        const g = Math.round(grid.color.g * 255);
        const b = Math.round(grid.color.b * 255);
        const a = grid.color.a;
        
        const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
        
        result.color = {
          hex,
          rgba: { r, g, b, a }
        };
      }
      
      if (grid.sectionSize !== undefined) {
        result.sectionSize = grid.sectionSize;
      }
      
      if (grid.offset !== undefined) {
        result.offset = grid.offset;
      }
      
      return result;
    });
  }

  /**
   * Enhances node information by adding local style metadata
   * @param fileKey The file key
   * @param nodes The array of nodes to enhance
   * @returns Promise resolving to nodes enhanced with style information
   */
  async enhanceNodesWithStyleInfo(fileKey: string, nodes: any[]): Promise<any[]> {
    try {
      // Get style mapping for the file
      const styleMapping = await this.mapNodesToLocalStyles(fileKey);
      
      // Create a lookup for quick access to which nodes use which styles
      const nodeToStyleMap: Record<string, Array<{
        styleId: string, 
        styleName: string, 
        styleType: string, 
        value: any
      }>> = {};
      
      // Build the node-to-style mapping from the style-to-node mapping
      for (const [styleId, mapping] of Object.entries(styleMapping.fillStyles)) {
        for (const nodeId of mapping.nodeIds) {
          if (!nodeToStyleMap[nodeId]) {
            nodeToStyleMap[nodeId] = [];
          }
          nodeToStyleMap[nodeId].push({
            styleId,
            styleName: mapping.styleName,
            styleType: 'FILL',
            value: mapping.value
          });
        }
      }
      
      for (const [styleId, mapping] of Object.entries(styleMapping.textStyles)) {
        for (const nodeId of mapping.nodeIds) {
          if (!nodeToStyleMap[nodeId]) {
            nodeToStyleMap[nodeId] = [];
          }
          nodeToStyleMap[nodeId].push({
            styleId,
            styleName: mapping.styleName,
            styleType: 'TEXT',
            value: mapping.value
          });
        }
      }
      
      for (const [styleId, mapping] of Object.entries(styleMapping.effectStyles)) {
        for (const nodeId of mapping.nodeIds) {
          if (!nodeToStyleMap[nodeId]) {
            nodeToStyleMap[nodeId] = [];
          }
          nodeToStyleMap[nodeId].push({
            styleId,
            styleName: mapping.styleName,
            styleType: 'EFFECT',
            value: mapping.value
          });
        }
      }
      
      for (const [styleId, mapping] of Object.entries(styleMapping.gridStyles)) {
        for (const nodeId of mapping.nodeIds) {
          if (!nodeToStyleMap[nodeId]) {
            nodeToStyleMap[nodeId] = [];
          }
          nodeToStyleMap[nodeId].push({
            styleId,
            styleName: mapping.styleName,
            styleType: 'GRID',
            value: mapping.value
          });
        }
      }
      
      // Process nodes recursively to add style information
      const processNode = (node: any): any => {
        // Clone the node to avoid modifying the original
        const enhancedNode = { ...node };
        
        // Add style information if this node has associated styles
        if (nodeToStyleMap[node.id]) {
          enhancedNode.localStyles = nodeToStyleMap[node.id];
        }
        
        // Process children recursively
        if (node.children && Array.isArray(node.children)) {
          enhancedNode.children = node.children.map(processNode);
        }
        
        return enhancedNode;
      };
      
      // Process all nodes
      return nodes.map(processNode);
    } catch (error) {
      Logger.error(`Error enhancing nodes with style info:`, error);
      return nodes; // Return original nodes if enhancement fails
    }
  }

  /**
   * Detects all style usage in a node and its children
   * @param fileKey The file key containing the nodes
   * @param nodeId The root node to check for style usage
   * @returns Promise resolving to a map of style IDs to the nodes that use them
   */
  async detectStyleUsage(fileKey: string, nodeId?: string): Promise<StyleUsageMap> {
    try {
      Logger.log(`Detecting style usage in file: ${fileKey}${nodeId ? `, node: ${nodeId}` : ''}`);
      
      // Get file data
      let fileData;
      if (nodeId) {
        fileData = await this.request<any>(`/files/${fileKey}/nodes?ids=${nodeId}`);
      } else {
        fileData = await this.request<any>(`/files/${fileKey}`);
      }
      
      // Initialize style usage map
      const styleUsage: StyleUsageMap = {
        fillStyleIds: {},
        textStyleIds: {},
        effectStyleIds: {},
        gridStyleIds: {}
      };
      
      // Define a recursive function to process each node
      const processNode = (node: any) => {
        if (!node) return;
        
        // Check for fill styles
        if (node.fillStyleId) {
          if (typeof node.fillStyleId === 'string') {
            // Single fill style
            if (!styleUsage.fillStyleIds[node.fillStyleId]) {
              styleUsage.fillStyleIds[node.fillStyleId] = [];
            }
            styleUsage.fillStyleIds[node.fillStyleId].push(node.id);
          } else if (typeof node.fillStyleId === 'object') {
            // Multiple fill styles (key-indexed)
            for (const [key, styleId] of Object.entries(node.fillStyleId)) {
              if (!styleUsage.fillStyleIds[styleId as string]) {
                styleUsage.fillStyleIds[styleId as string] = [];
              }
              styleUsage.fillStyleIds[styleId as string].push(`${node.id}:${key}`);
            }
          }
        }
        
        // Check for text styles
        if (node.textStyleId) {
          if (!styleUsage.textStyleIds[node.textStyleId]) {
            styleUsage.textStyleIds[node.textStyleId] = [];
          }
          styleUsage.textStyleIds[node.textStyleId].push(node.id);
        }
        
        // Check for effect styles
        if (node.effectStyleId) {
          if (!styleUsage.effectStyleIds[node.effectStyleId]) {
            styleUsage.effectStyleIds[node.effectStyleId] = [];
          }
          styleUsage.effectStyleIds[node.effectStyleId].push(node.id);
        }
        
        // Check for grid styles
        if (node.gridStyleId) {
          if (!styleUsage.gridStyleIds[node.gridStyleId]) {
            styleUsage.gridStyleIds[node.gridStyleId] = [];
          }
          styleUsage.gridStyleIds[node.gridStyleId].push(node.id);
        }
        
        // Process children recursively
        if (node.children && Array.isArray(node.children)) {
          node.children.forEach(processNode);
        }
      };
      
      // Start processing from either the specified node or the document
      if (nodeId && fileData.nodes && fileData.nodes[nodeId]) {
        processNode(fileData.nodes[nodeId].document);
      } else if (fileData.document) {
        processNode(fileData.document);
      }
      
      writeLogs(`figma-style-usage-${fileKey}${nodeId ? `-${nodeId}` : ''}.json`, styleUsage);
      return styleUsage;
    } catch (e) {
      console.error("Failed to detect style usage:", e);
      throw e;
    }
  }

  /**
   * Enhances a Figma node by directly embedding style name and value information 
   * instead of just referencing style IDs.
   * 
   * This makes it easier for AI tools to understand which styles are applied
   * without having to cross-reference with separate style definitions.
   */
  async enhanceNodesWithStyleNames(fileKey: string, nodes: any[]): Promise<any[]> {
    try {
      // Get all styles from the file
      const allStyles = await this.getStyles(fileKey);
      
      // Create lookup maps for each style type by their ID
      const styleMap: Record<string, FigmaStyle> = {};
      
      // Combine all styles into a single lookup map
      [...allStyles.paintStyles, ...allStyles.textStyles, 
       ...allStyles.effectStyles, ...allStyles.gridStyles].forEach(style => {
        styleMap[style.key] = style;
      });
      
      // Process nodes recursively
      const enhanceNode = (node: any): any => {
        if (!node) return node;
        
        // Create enhanced node with style information
        const enhancedNode = { ...node };
        
        // Add style mapping information to node
        if (node.styles) {
          enhancedNode.styleInfo = {};
          
          // Process each style reference
          Object.entries(node.styles).forEach(([styleType, styleId]) => {
            if (styleMap[styleId as string]) {
              const style = styleMap[styleId as string];
              enhancedNode.styleInfo[styleType] = {
                id: styleId,
                name: style.name,
                type: style.style_type
              };
            }
          });
        }
        
        // Process text style specifically
        if (node.textStyle && typeof node.textStyle === 'string' && styleMap[node.textStyle]) {
          enhancedNode.textStyleInfo = {
            id: node.textStyle,
            name: styleMap[node.textStyle].name,
            type: 'TEXT'
          };
        }
        
        // Process fills specifically
        if (node.fills && typeof node.fills === 'string' && styleMap[node.fills]) {
          enhancedNode.fillsInfo = {
            id: node.fills,
            name: styleMap[node.fills].name,
            type: 'FILL'
          };
        }
        
        // Process strokes specifically
        if (node.strokes && typeof node.strokes === 'string' && styleMap[node.strokes]) {
          enhancedNode.strokesInfo = {
            id: node.strokes,
            name: styleMap[node.strokes].name,
            type: 'STROKE'
          };
        }
        
        // Process effects specifically
        if (node.effects && typeof node.effects === 'string' && styleMap[node.effects]) {
          enhancedNode.effectsInfo = {
            id: node.effects,
            name: styleMap[node.effects].name,
            type: 'EFFECT'
          };
        }
        
        // Process children recursively
        if (node.children && Array.isArray(node.children)) {
          enhancedNode.children = node.children.map(enhanceNode);
        }
        
        return enhancedNode;
      };
      
      return nodes.map(enhanceNode);
    } catch (error) {
      console.error("Error enhancing nodes with style names:", error);
      return nodes; // Return original nodes on error
    }
  }

  /**
   * Creates a comprehensive style usage summary with detailed information
   * about which styles are used and where they appear in the design.
   */
  async createStyleUsageSummary(fileKey: string, nodeId?: string): Promise<{
    colors: Array<{
      name: string;
      styleId: string;
      value: any;
      usageCount: number;
      usedIn: string[];
    }>;
    textStyles: Array<{
      name: string;
      styleId: string;
      value: any;
      usageCount: number;
      usedIn: string[];
    }>;
    effectStyles: Array<{
      name: string;
      styleId: string;
      value: any;
      usageCount: number;
      usedIn: string[];
    }>;
    gridStyles: Array<{
      name: string;
      styleId: string;
      value: any;
      usageCount: number;
      usedIn: string[];
    }>;
  }> {
    try {
      // Get style usage information
      const styleUsage = await this.detectStyleUsage(fileKey, nodeId);
      
      // Get all styles
      const allStyles = await this.getStyles(fileKey);
      
      // Create maps for each style type
      const paintStyleMap = new Map(allStyles.paintStyles.map(s => [s.key, s]));
      const textStyleMap = new Map(allStyles.textStyles.map(s => [s.key, s]));
      const effectStyleMap = new Map(allStyles.effectStyles.map(s => [s.key, s]));
      const gridStyleMap = new Map(allStyles.gridStyles.map(s => [s.key, s]));
      
      // Get detailed style information for used styles
      const usedStyleKeys = [
        ...Object.keys(styleUsage.fillStyleIds),
        ...Object.keys(styleUsage.textStyleIds),
        ...Object.keys(styleUsage.effectStyleIds),
        ...Object.keys(styleUsage.gridStyleIds)
      ];
      
      // Get detailed style information
      const styleDetails = await this.getMultipleStyleDetails(usedStyleKeys);
      
      // Build enhanced usage summary
      const summary = {
        colors: [] as Array<{
          name: string;
          styleId: string;
          value: any;
          usageCount: number;
          usedIn: string[];
        }>,
        textStyles: [] as Array<{
          name: string;
          styleId: string;
          value: any;
          usageCount: number;
          usedIn: string[];
        }>,
        effectStyles: [] as Array<{
          name: string;
          styleId: string;
          value: any;
          usageCount: number;
          usedIn: string[];
        }>,
        gridStyles: [] as Array<{
          name: string;
          styleId: string;
          value: any;
          usageCount: number;
          usedIn: string[];
        }>
      };
      
      // Process color styles
      for (const [styleId, nodeIds] of Object.entries(styleUsage.fillStyleIds)) {
        const style = paintStyleMap.get(styleId);
        const details = styleDetails[styleId] as FigmaPaintStyleDetails;
        
        if (style && details) {
          const styleValue = this.extractFillStyleValue(details);
          summary.colors.push({
            name: style.name,
            styleId: styleId,
            value: styleValue,
            usageCount: nodeIds.length,
            usedIn: nodeIds
          });
        }
      }
      
      // Process text styles
      for (const [styleId, nodeIds] of Object.entries(styleUsage.textStyleIds)) {
        const style = textStyleMap.get(styleId);
        const details = styleDetails[styleId] as FigmaTextStyleDetails;
        
        if (style && details) {
          const styleValue = this.extractTextStyleValue(details);
          summary.textStyles.push({
            name: style.name,
            styleId: styleId,
            value: styleValue,
            usageCount: nodeIds.length,
            usedIn: nodeIds
          });
        }
      }
      
      // Process effect styles
      for (const [styleId, nodeIds] of Object.entries(styleUsage.effectStyleIds)) {
        const style = effectStyleMap.get(styleId);
        const details = styleDetails[styleId] as FigmaEffectStyleDetails;
        
        if (style && details) {
          const styleValue = this.extractEffectStyleValue(details);
          summary.effectStyles.push({
            name: style.name,
            styleId: styleId,
            value: styleValue,
            usageCount: nodeIds.length,
            usedIn: nodeIds
          });
        }
      }
      
      // Process grid styles
      for (const [styleId, nodeIds] of Object.entries(styleUsage.gridStyleIds)) {
        const style = gridStyleMap.get(styleId);
        const details = styleDetails[styleId] as FigmaGridStyleDetails;
        
        if (style && details) {
          const styleValue = this.extractGridStyleValue(details);
          summary.gridStyles.push({
            name: style.name,
            styleId: styleId,
            value: styleValue,
            usageCount: nodeIds.length,
            usedIn: nodeIds
          });
        }
      }
      
      return summary;
    } catch (error) {
      console.error("Error creating style usage summary:", error);
      return {
        colors: [],
        textStyles: [],
        effectStyles: [],
        gridStyles: []
      };
    }
  }
}

function writeLogs(name: string, value: any) {
  try {
    if (process.env.NODE_ENV !== "development") return;

    const logsDir = "logs";

    try {
      fs.accessSync(process.cwd(), fs.constants.W_OK);
    } catch (error) {
      Logger.log("Failed to write logs:", error);
      return;
    }

    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir);
    }
    fs.writeFileSync(`${logsDir}/${name}`, JSON.stringify(value, null, 2));
  } catch (error) {
    console.debug("Failed to write logs:", error);
  }
}
