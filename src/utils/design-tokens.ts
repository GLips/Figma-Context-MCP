import { SimplifiedDesign } from "../services/simplify-node-response";

export interface DesignTokens {
  colors: ColorToken[];
  typography: TypographyToken[];
  spacing: SpacingToken[];
  shadows: ShadowToken[];
}

export interface ColorToken {
  name: string;
  value: string;
  rgba: {
    r: number;
    g: number;
    b: number;
    a: number;
  };
}

export interface TypographyToken {
  name: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  lineHeight?: number;
  letterSpacing?: number;
}

export interface SpacingToken {
  name: string;
  value: number;
}

export interface ShadowToken {
  name: string;
  color: string;
  x: number;
  y: number;
  blur: number;
  spread?: number;
}

/**
 * Extracts design tokens from a Figma design
 */
export function extractDesignTokens(design: SimplifiedDesign): DesignTokens {
  const tokens: DesignTokens = {
    colors: [],
    typography: [],
    spacing: [],
    shadows: [],
  };

  // Extract colors from global variables if available
  if (design.globalVars?.styles) {
    // Process styles to find color tokens
    for (const [styleId, styleValue] of Object.entries(design.globalVars.styles)) {
      // Check if it's a color style (simplified fill array)
      if (Array.isArray(styleValue) && styleValue.length > 0) {
        const fill = styleValue[0];
        if (typeof fill === 'object' && 'rgba' in fill) {
          // Parse RGBA string: rgba(r, g, b, a)
          const rgbaMatch = fill.rgba?.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
          if (rgbaMatch) {
            const r = parseInt(rgbaMatch[1], 10);
            const g = parseInt(rgbaMatch[2], 10);
            const b = parseInt(rgbaMatch[3], 10);
            const a = parseFloat(rgbaMatch[4]);
            
            tokens.colors.push({
              name: formatTokenName(styleId),
              value: `Color(red: ${(r/255).toFixed(3)}, green: ${(g/255).toFixed(3)}, blue: ${(b/255).toFixed(3)}${a < 1 ? `, opacity: ${a.toFixed(3)}` : ''})`,
              rgba: { r, g, b, a },
            });
          }
        }
      }
    }
  }

  // Extract colors from nodes if no global variables
  if (tokens.colors.length === 0) {
    const colorMap = new Map<string, ColorToken>();
    
    // Process all nodes to find unique colors
    for (const node of design.nodes) {
      extractColorsFromNode(node, colorMap);
    }
    
    tokens.colors = Array.from(colorMap.values());
  }

  // Extract typography styles
  const typographyMap = new Map<string, TypographyToken>();
  
  // Process all nodes to find unique typography styles
  for (const node of design.nodes) {
    extractTypographyFromNode(node, typographyMap);
  }
  
  tokens.typography = Array.from(typographyMap.values());

  // Extract spacing values
  const spacingMap = new Map<number, SpacingToken>();
  
  // Process all nodes to find unique spacing values
  for (const node of design.nodes) {
    extractSpacingFromNode(node, spacingMap);
  }
  
  tokens.spacing = Array.from(spacingMap.values());

  // Extract shadow styles
  const shadowMap = new Map<string, ShadowToken>();
  
  // Process all nodes to find unique shadow styles
  for (const node of design.nodes) {
    extractShadowsFromNode(node, shadowMap);
  }
  
  tokens.shadows = Array.from(shadowMap.values());

  return tokens;
}

/**
 * Recursively extracts colors from a node and its children
 */
function extractColorsFromNode(node: any, colorMap: Map<string, ColorToken>): void {
  // Extract fill colors
  if (node.style?.fills && node.style.fills.length > 0) {
    for (const fill of node.style.fills) {
      if (fill.type === 'SOLID' && fill.color) {
        const r = Math.round(fill.color.r * 255);
        const g = Math.round(fill.color.g * 255);
        const b = Math.round(fill.color.b * 255);
        const a = fill.opacity !== undefined ? fill.opacity : (fill.color.a !== undefined ? fill.color.a : 1);
        
        // Create a key for this color
        const colorKey = `${r}-${g}-${b}-${a}`;
        
        if (!colorMap.has(colorKey)) {
          const colorName = generateColorName(r, g, b, a);
          colorMap.set(colorKey, {
            name: colorName,
            value: `Color(red: ${(r/255).toFixed(3)}, green: ${(g/255).toFixed(3)}, blue: ${(b/255).toFixed(3)}${a < 1 ? `, opacity: ${a.toFixed(3)}` : ''})`,
            rgba: { r, g, b, a },
          });
        }
      }
    }
  }
  
  // Extract stroke colors
  if (node.style?.strokes && node.style.strokes.length > 0) {
    for (const stroke of node.style.strokes) {
      if (stroke.type === 'SOLID' && stroke.color) {
        const r = Math.round(stroke.color.r * 255);
        const g = Math.round(stroke.color.g * 255);
        const b = Math.round(stroke.color.b * 255);
        const a = stroke.opacity !== undefined ? stroke.opacity : (stroke.color.a !== undefined ? stroke.color.a : 1);
        
        // Create a key for this color
        const colorKey = `${r}-${g}-${b}-${a}`;
        
        if (!colorMap.has(colorKey)) {
          const colorName = generateColorName(r, g, b, a);
          colorMap.set(colorKey, {
            name: colorName,
            value: `Color(red: ${(r/255).toFixed(3)}, green: ${(g/255).toFixed(3)}, blue: ${(b/255).toFixed(3)}${a < 1 ? `, opacity: ${a.toFixed(3)}` : ''})`,
            rgba: { r, g, b, a },
          });
        }
      }
    }
  }
  
  // Process children recursively
  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      extractColorsFromNode(child, colorMap);
    }
  }
}

/**
 * Recursively extracts typography styles from a node and its children
 */
function extractTypographyFromNode(node: any, typographyMap: Map<string, TypographyToken>): void {
  // Extract typography from text nodes
  if (node.type === 'TEXT' && node.style) {
    const { fontName, fontSize, fontWeight, lineHeightPx, letterSpacing } = node.style;
    
    if (fontName && fontSize) {
      // Create a key for this typography style
      const typographyKey = `${fontName}-${fontSize}-${fontWeight || 'regular'}`;
      
      if (!typographyMap.has(typographyKey)) {
        const typographyName = `typography${formatTokenName(fontName)}${fontSize}${formatTokenName(fontWeight || 'Regular')}`;
        typographyMap.set(typographyKey, {
          name: typographyName,
          fontFamily: fontName,
          fontSize,
          fontWeight: fontWeight || 'regular',
          lineHeight: lineHeightPx,
          letterSpacing: letterSpacing,
        });
      }
    }
  }
  
  // Process children recursively
  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      extractTypographyFromNode(child, typographyMap);
    }
  }
}

/**
 * Recursively extracts spacing values from a node and its children
 */
function extractSpacingFromNode(node: any, spacingMap: Map<number, SpacingToken>): void {
  // Extract padding values
  if (node.layout?.padding) {
    if (typeof node.layout.padding === 'string') {
      const padding = parseInt(node.layout.padding.replace('px', ''));
      if (!isNaN(padding) && padding > 0) {
        if (!spacingMap.has(padding)) {
          spacingMap.set(padding, {
            name: `spacing${padding}`,
            value: padding,
          });
        }
      }
    } else if (typeof node.layout.padding === 'object') {
      const { top, right, bottom, left } = node.layout.padding;
      [top, right, bottom, left].forEach(value => {
        if (value !== undefined && value > 0) {
          if (!spacingMap.has(value)) {
            spacingMap.set(value, {
              name: `spacing${value}`,
              value,
            });
          }
        }
      });
    }
  }
  
  // Extract gap values
  if (node.layout?.gap) {
    const gap = parseInt(node.layout.gap.replace('px', ''));
    if (!isNaN(gap) && gap > 0) {
      if (!spacingMap.has(gap)) {
        spacingMap.set(gap, {
          name: `spacing${gap}`,
          value: gap,
        });
      }
    }
  }
  
  // Process children recursively
  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      extractSpacingFromNode(child, spacingMap);
    }
  }
}

/**
 * Recursively extracts shadow styles from a node and its children
 */
function extractShadowsFromNode(node: any, shadowMap: Map<string, ShadowToken>): void {
  // Extract shadow effects
  if (node.effects?.shadows && node.effects.shadows.length > 0) {
    for (const shadow of node.effects.shadows) {
      if (shadow.color) {
        const r = Math.round(shadow.color.r * 255);
        const g = Math.round(shadow.color.g * 255);
        const b = Math.round(shadow.color.b * 255);
        const a = shadow.opacity !== undefined ? shadow.opacity : (shadow.color.a !== undefined ? shadow.color.a : 0.3);
        const x = shadow.offset?.x || 0;
        const y = shadow.offset?.y || 0;
        const blur = shadow.radius || 5;
        const spread = shadow.spread;
        
        // Create a key for this shadow
        const shadowKey = `${r}-${g}-${b}-${a}-${x}-${y}-${blur}-${spread || 0}`;
        
        if (!shadowMap.has(shadowKey)) {
          const shadowName = `shadow${blur}${x !== 0 || y !== 0 ? `Offset${Math.abs(x)}${Math.abs(y)}` : ''}`;
          shadowMap.set(shadowKey, {
            name: shadowName,
            color: `Color(red: ${(r/255).toFixed(3)}, green: ${(g/255).toFixed(3)}, blue: ${(b/255).toFixed(3)}, opacity: ${a.toFixed(3)})`,
            x,
            y,
            blur,
            spread,
          });
        }
      }
    }
  }
  
  // Process children recursively
  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      extractShadowsFromNode(child, shadowMap);
    }
  }
}

/**
 * Generates a color name based on RGB values
 */
function generateColorName(r: number, g: number, b: number, a: number): string {
  // Check for standard colors
  if (r === 255 && g === 0 && b === 0 && a === 1) return 'red';
  if (r === 0 && g === 0 && b === 255 && a === 1) return 'blue';
  if (r === 0 && g === 255 && b === 0 && a === 1) return 'green';
  if (r === 0 && g === 0 && b === 0 && a === 1) return 'black';
  if (r === 255 && g === 255 && b === 255 && a === 1) return 'white';
  
  // Generate a name based on hue and brightness
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const brightness = max / 255;
  const saturation = max === 0 ? 0 : (max - min) / max;
  
  let hue = 0;
  if (max === min) {
    hue = 0; // achromatic
  } else {
    const delta = max - min;
    if (max === r) {
      hue = (g - b) / delta + (g < b ? 6 : 0);
    } else if (max === g) {
      hue = (b - r) / delta + 2;
    } else {
      hue = (r - g) / delta + 4;
    }
    hue *= 60;
  }
  
  // Determine color name based on hue
  let colorName = '';
  if (saturation < 0.1) {
    if (brightness < 0.2) colorName = 'darkGray';
    else if (brightness < 0.5) colorName = 'gray';
    else if (brightness < 0.8) colorName = 'lightGray';
    else colorName = 'offWhite';
  } else {
    if (hue < 30) colorName = 'red';
    else if (hue < 60) colorName = 'orange';
    else if (hue < 90) colorName = 'yellow';
    else if (hue < 150) colorName = 'green';
    else if (hue < 210) colorName = 'cyan';
    else if (hue < 270) colorName = 'blue';
    else if (hue < 330) colorName = 'purple';
    else colorName = 'red';
    
    // Add brightness modifier
    if (brightness < 0.3) colorName = 'dark' + capitalize(colorName);
    else if (brightness > 0.7) colorName = 'light' + capitalize(colorName);
  }
  
  // Add opacity suffix if not fully opaque
  if (a < 1) {
    colorName += 'Alpha' + Math.round(a * 100);
  }
  
  return colorName;
}

/**
 * Formats a token name to be camelCase
 */
function formatTokenName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]/g, ' ')
    .split(' ')
    .map((word, index) => index === 0 ? word.toLowerCase() : capitalize(word))
    .join('');
}

/**
 * Capitalizes the first letter of a string
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Generates SwiftUI code for design tokens
 */
export function generateDesignTokensCode(tokens: DesignTokens): string {
  let code = 'import SwiftUI\n\n';
  code += '// MARK: - Design Tokens\n';
  code += 'struct DesignTokens {\n';
  
  // Generate color tokens
  if (tokens.colors.length > 0) {
    code += '    // MARK: - Colors\n';
    code += '    struct Colors {\n';
    for (const color of tokens.colors) {
      code += `        static let ${color.name} = ${color.value}\n`;
    }
    code += '    }\n\n';
  }
  
  // Generate typography tokens
  if (tokens.typography.length > 0) {
    code += '    // MARK: - Typography\n';
    code += '    struct Typography {\n';
    for (const typography of tokens.typography) {
      code += `        static let ${typography.name} = Font.system(size: ${typography.fontSize}, weight: ${getSwiftUIFontWeight(typography.fontWeight)})\n`;
    }
    code += '    }\n\n';
  }
  
  // Generate spacing tokens
  if (tokens.spacing.length > 0) {
    code += '    // MARK: - Spacing\n';
    code += '    struct Spacing {\n';
    for (const spacing of tokens.spacing) {
      code += `        static let ${spacing.name} = CGFloat(${spacing.value})\n`;
    }
    code += '    }\n\n';
  }
  
  // Generate shadow tokens
  if (tokens.shadows.length > 0) {
    code += '    // MARK: - Shadows\n';
    code += '    struct Shadows {\n';
    for (const shadow of tokens.shadows) {
      code += `        static let ${shadow.name} = Shadow(color: ${shadow.color}, radius: ${shadow.blur}, x: ${shadow.x}, y: ${shadow.y}${shadow.spread !== undefined ? `, spread: ${shadow.spread}` : ''})\n`;
    }
    code += '    }\n';
  }
  
  code += '}\n';
  return code;
}

/**
 * Converts a font weight to SwiftUI font weight
 */
function getSwiftUIFontWeight(weight: string | number | undefined): string {
  if (!weight) return '.regular';
  
  if (typeof weight === 'string') {
    switch (weight.toLowerCase()) {
      case 'thin': return '.thin';
      case 'ultralight': return '.ultraLight';
      case 'light': return '.light';
      case 'regular': return '.regular';
      case 'medium': return '.medium';
      case 'semibold': return '.semibold';
      case 'bold': return '.bold';
      case 'heavy': return '.heavy';
      case 'black': return '.black';
      default: return '.regular';
    }
  } else if (typeof weight === 'number') {
    if (weight < 200) return '.thin';
    if (weight < 300) return '.light';
    if (weight < 400) return '.regular';
    if (weight < 500) return '.regular';
    if (weight < 600) return '.medium';
    if (weight < 700) return '.semibold';
    if (weight < 800) return '.bold';
    if (weight < 900) return '.heavy';
    return '.black';
  }
  
  return '.regular';
} 