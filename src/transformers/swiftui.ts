import { SimplifiedDesign } from "../services/simplify-node-response";
import { SimplifiedLayout } from "./layout";
import { SimplifiedStroke } from "./style";
import { SimplifiedEffects } from "./effects";
import { DesignTokens, extractDesignTokens, generateDesignTokensCode } from "../utils/design-tokens";
import { generateResponsiveLayoutCode, shouldUseResponsiveLayout } from "../utils/responsive-layout";

export function generateSwiftUICode(design: SimplifiedDesign, forceResponsiveLayout?: boolean): string {
  console.log('🚀 Starting SwiftUI code generation for:', design.name);
  
  // Extract design tokens
  console.log('📦 Extracting design tokens...');
  const designTokens = extractDesignTokens(design);
  console.log(`✅ Extracted ${designTokens.colors.length} colors, ${designTokens.typography.length} typography styles, ${designTokens.spacing.length} spacing values`);
  
  // Generate design tokens code
  console.log('🎨 Generating design tokens code...');
  const tokensCode = generateDesignTokensCode(designTokens);
  
  // Check if we should use responsive layout
  let useResponsiveLayout = forceResponsiveLayout !== undefined 
    ? forceResponsiveLayout 
    : shouldUseResponsiveLayout(design);
  console.log(`📱 Using responsive layout: ${useResponsiveLayout}`);
  
  // Generate responsive layout code if needed
  let responsiveCode = '';
  if (useResponsiveLayout) {
    console.log('📐 Generating responsive layout code...');
    responsiveCode = generateResponsiveLayoutCode();
  }
  
  // Generate main view code
  console.log('🏗️ Generating main view code...');
  const viewCode = generateViewCode(design, designTokens, useResponsiveLayout);
  
  // Combine all code
  console.log('🎉 SwiftUI code generation completed!');
  if (useResponsiveLayout) {
    return `${tokensCode}\n\n${responsiveCode}\n\n${viewCode}`;
  } else {
    return `${tokensCode}\n\n${viewCode}`;
  }
}

function generateViewCode(design: SimplifiedDesign, tokens: DesignTokens, useResponsiveLayout: boolean): string {
  // Main function to generate the complete SwiftUI code
  const imports = generateImports();
  const structDefinition = generateStructDefinition(design);
  const body = generateBody(design, tokens, useResponsiveLayout);
  const previews = generatePreviews(design);
  
  return `${imports}\n\n${structDefinition}\n${body}\n${previews}`;
}

function generateImports(): string {
  return `import SwiftUI`;
}

function generateStructDefinition(design: SimplifiedDesign): string {
  return `struct ${sanitizeName(design.name)}View: View {`;
}

function sanitizeName(name: string): string {
  // Remove spaces and special characters, ensure first character is uppercase
  return name.replace(/[^a-zA-Z0-9]/g, '')
    .replace(/^([a-z])/, (match) => match.toUpperCase());
}

function generateBody(design: SimplifiedDesign, tokens: DesignTokens, useResponsiveLayout: boolean): string {
  let code = '    var body: some View {\n';
  
  // Process the root node and its children
  if (design.nodes.length > 0) {
    const rootNode = design.nodes[0];
    code += processNode(rootNode, 2, tokens, useResponsiveLayout);
  }
  
  code += '    }\n';
  return code;
}

function processNode(node: any, indentLevel: number, tokens: DesignTokens, useResponsiveLayout: boolean): string {
  const indent = ' '.repeat(indentLevel * 4);
  let code = '';
  
  // Handle different node types
  switch (node.type) {
    case 'FRAME':
    case 'GROUP':
    case 'COMPONENT':
    case 'INSTANCE':
      code += processFrameOrGroup(node, indentLevel, tokens, useResponsiveLayout);
      break;
    case 'TEXT':
      code += processText(node, indentLevel, tokens, useResponsiveLayout);
      break;
    case 'RECTANGLE':
      code += processRectangle(node, indentLevel, tokens, useResponsiveLayout);
      break;
    case 'ELLIPSE':
      code += processEllipse(node, indentLevel, tokens, useResponsiveLayout);
      break;
    case 'VECTOR':
      code += processVector(node, indentLevel, tokens, useResponsiveLayout);
      break;
    case 'LINE':
      code += processLine(node, indentLevel, tokens, useResponsiveLayout);
      break;
    case 'IMAGE':
      code += processImage(node, indentLevel, tokens, useResponsiveLayout);
      break;
    default:
      code += `${indent}// Unsupported node type: ${node.type}\n`;
      code += `${indent}EmptyView()\n`;
  }
  
  return code;
}

// Implement specific node type processors
function processFrameOrGroup(node: any, indentLevel: number, tokens: DesignTokens, useResponsiveLayout: boolean): string {
  const indent = ' '.repeat(indentLevel * 4);
  let code = '';
  
  // Determine if VStack or HStack based on layout
  const layout = node.layout || { mode: 'none' };
  const stackType = layout.mode === 'column' ? 'VStack' : layout.mode === 'row' ? 'HStack' : 'ZStack';
  
  // Start stack definition
  code += `${indent}${stackType}(`;
  
  // Add alignment and spacing if applicable
  if (layout.mode !== 'none') {
    const alignment = getSwiftUIAlignment(layout);
    let spacing = null;
    
    // Try to use spacing token if available
    if (layout.gap) {
      const gapValue = parseInt(layout.gap.replace('px', ''));
      const spacingToken = tokens.spacing.find(s => s.value === gapValue);
      if (spacingToken) {
        spacing = `DesignTokens.Spacing.${spacingToken.name}`;
      } else {
        spacing = gapValue;
      }
    }
    
    let params = [];
    if (alignment !== '.center') {
      params.push(`alignment: ${alignment}`);
    }
    if (spacing !== null) {
      params.push(`spacing: ${spacing}`);
    }
    
    code += params.join(', ');
  }
  code += `) {\n`;
  
  // Process children
  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      code += processNode(child, indentLevel + 1, tokens, useResponsiveLayout);
    }
  }
  
  // Close stack and add modifiers
  code += `${indent}}\n`;
  code += applyModifiers(node, indentLevel, tokens, useResponsiveLayout);
  
  return code;
}

function processText(node: any, indentLevel: number, tokens: DesignTokens, useResponsiveLayout: boolean): string {
  const indent = ' '.repeat(indentLevel * 4);
  // Escape quotes in text content
  const textContent = (node.characters || '').replace(/"/g, '\\"');
  let code = `${indent}Text("${textContent}")\n`;
  code += applyTextModifiers(node, indentLevel, tokens, useResponsiveLayout);
  code += applyModifiers(node, indentLevel, tokens, useResponsiveLayout);
  return code;
}

function applyTextModifiers(node: any, indentLevel: number, tokens: DesignTokens, useResponsiveLayout: boolean): string {
  const indent = ' '.repeat(indentLevel * 4);
  let modifiers = '';
  
  // Apply font if it's a text node
  if (node.style?.fontName) {
    const fontSize = node.style.fontSize || 14;
    const fontWeight = node.style.fontWeight || 'regular';
    
    // Try to use typography token if available
    const typographyToken = tokens.typography.find(
      t => t.fontSize === fontSize && t.fontWeight.toLowerCase() === fontWeight.toLowerCase()
    );
    
    if (typographyToken) {
      modifiers += `${indent}    .font(DesignTokens.Typography.${typographyToken.name})\n`;
    } else if (useResponsiveLayout) {
      // Use responsive font
      const fontWeightValue = getSwiftUIFontWeight(fontWeight);
      modifiers += `${indent}    .responsiveFont(size: ${fontSize}, weight: ${fontWeightValue})\n`;
    } else {
      const fontWeightValue = getSwiftUIFontWeight(fontWeight);
      modifiers += `${indent}    .font(.system(size: ${fontSize}, weight: ${fontWeightValue}))\n`;
    }
  }
  
  // Apply text alignment
  if (node.style?.textAlignHorizontal) {
    const alignment = getSwiftUITextAlignment(node.style.textAlignHorizontal);
    if (alignment) {
      modifiers += `${indent}    .multilineTextAlignment(${alignment})\n`;
    }
  }
  
  // Apply line spacing
  if (node.style?.lineHeightPx && node.style?.fontSize) {
    const lineHeight = node.style.lineHeightPx;
    const fontSize = node.style.fontSize;
    if (lineHeight > fontSize) {
      const lineSpacing = lineHeight - fontSize;
      modifiers += `${indent}    .lineSpacing(${lineSpacing})\n`;
    }
  }
  
  // Apply text color
  if (node.style?.fills && node.style.fills.length > 0) {
    const fill = node.style.fills[0];
    if (fill.type === 'SOLID' && fill.color) {
      const color = getTokenizedColor(fill.color, fill.opacity, tokens);
      modifiers += `${indent}    .foregroundColor(${color})\n`;
    }
  }
  
  return modifiers;
}

function processRectangle(node: any, indentLevel: number, tokens: DesignTokens, useResponsiveLayout: boolean): string {
  const indent = ' '.repeat(indentLevel * 4);
  
  // Check if it's a simple rectangle or a rounded rectangle
  const cornerRadius = node.style?.cornerRadius || 0;
  
  let code;
  if (cornerRadius > 0) {
    code = `${indent}RoundedRectangle(cornerRadius: ${cornerRadius})\n`;
  } else {
    code = `${indent}Rectangle()\n`;
  }
  
  // Apply fill
  if (node.style?.fills && node.style.fills.length > 0) {
    const fill = node.style.fills[0];
    if (fill.type === 'SOLID' && fill.color) {
      const color = getTokenizedColor(fill.color, fill.opacity, tokens);
      code += `${indent}    .fill(${color})\n`;
    } else if (fill.type === 'GRADIENT_LINEAR' && fill.gradientStops) {
      code += applyLinearGradient(fill, indentLevel, tokens);
    }
  } else {
    // If no fill, use a stroke
    code += `${indent}    .stroke(Color.black, lineWidth: 1)\n`;
  }
  
  code += applyModifiers(node, indentLevel, tokens, useResponsiveLayout);
  return code;
}

function processEllipse(node: any, indentLevel: number, tokens: DesignTokens, useResponsiveLayout: boolean): string {
  const indent = ' '.repeat(indentLevel * 4);
  
  // Check dimensions to determine if it's a circle or ellipse
  const isCircle = node.layout?.dimensions?.width === node.layout?.dimensions?.height;
  
  let code;
  if (isCircle) {
    code = `${indent}Circle()\n`;
  } else {
    code = `${indent}Ellipse()\n`;
  }
  
  // Apply fill
  if (node.style?.fills && node.style.fills.length > 0) {
    const fill = node.style.fills[0];
    if (fill.type === 'SOLID' && fill.color) {
      const color = getTokenizedColor(fill.color, fill.opacity, tokens);
      code += `${indent}    .fill(${color})\n`;
    } else if (fill.type === 'GRADIENT_LINEAR' && fill.gradientStops) {
      code += applyLinearGradient(fill, indentLevel, tokens);
    }
  } else {
    // If no fill, use a stroke
    code += `${indent}    .stroke(Color.black, lineWidth: 1)\n`;
  }
  
  code += applyModifiers(node, indentLevel, tokens, useResponsiveLayout);
  return code;
}

function processVector(node: any, indentLevel: number, tokens: DesignTokens, useResponsiveLayout: boolean): string {
  const indent = ' '.repeat(indentLevel * 4);
  
  // For vectors, we'll use an Image with a system name as a placeholder
  // In a real implementation, you'd convert the vector path to SwiftUI Path
  let code = `${indent}// Vector shape converted to Image\n`;
  code += `${indent}Image(systemName: "square")\n`;
  code += `${indent}    .resizable()\n`;
  
  // Apply fill color if available
  if (node.style?.fills && node.style.fills.length > 0) {
    const fill = node.style.fills[0];
    if (fill.type === 'SOLID' && fill.color) {
      const color = getTokenizedColor(fill.color, fill.opacity, tokens);
      code += `${indent}    .foregroundColor(${color})\n`;
    }
  }
  
  code += applyModifiers(node, indentLevel, tokens, useResponsiveLayout);
  return code;
}

function processLine(node: any, indentLevel: number, tokens: DesignTokens, useResponsiveLayout: boolean): string {
  const indent = ' '.repeat(indentLevel * 4);
  
  // For lines, we'll use a Rectangle with a small height/width
  const isHorizontal = (node.layout?.dimensions?.width || 0) > (node.layout?.dimensions?.height || 0);
  
  let code = `${indent}// Line converted to Rectangle\n`;
  code += `${indent}Rectangle()\n`;
  
  // Apply stroke color if available
  if (node.style?.strokes && node.style.strokes.length > 0) {
    const stroke = node.style.strokes[0];
    if (stroke.type === 'SOLID' && stroke.color) {
      const color = getTokenizedColor(stroke.color, stroke.opacity, tokens);
      code += `${indent}    .fill(${color})\n`;
    }
  } else {
    code += `${indent}    .fill(Color.black)\n`;
  }
  
  // Set the frame based on line orientation
  if (isHorizontal) {
    if (useResponsiveLayout) {
      code += `${indent}    .responsiveFrame(smallWidth: ${node.layout?.dimensions?.width || 100}, smallHeight: ${node.style?.strokeWeight || 1})\n`;
    } else {
      code += `${indent}    .frame(width: ${node.layout?.dimensions?.width || 100}, height: ${node.style?.strokeWeight || 1})\n`;
    }
  } else {
    if (useResponsiveLayout) {
      code += `${indent}    .responsiveFrame(smallWidth: ${node.style?.strokeWeight || 1}, smallHeight: ${node.layout?.dimensions?.height || 100})\n`;
    } else {
      code += `${indent}    .frame(width: ${node.style?.strokeWeight || 1}, height: ${node.layout?.dimensions?.height || 100})\n`;
    }
  }
  
  code += applyModifiers(node, indentLevel, tokens, useResponsiveLayout);
  return code;
}

function processImage(node: any, indentLevel: number, tokens: DesignTokens, useResponsiveLayout: boolean): string {
  const indent = ' '.repeat(indentLevel * 4);
  
  // Use the node name as the image name, sanitized for Swift
  const imageName = sanitizeName(node.name);
  
  let code = `${indent}Image("${imageName}")\n`;
  code += `${indent}    .resizable()\n`;
  code += `${indent}    .scaledToFit()\n`;
  
  code += applyModifiers(node, indentLevel, tokens, useResponsiveLayout);
  return code;
}

function applyModifiers(node: any, indentLevel: number, tokens: DesignTokens, useResponsiveLayout: boolean): string {
  const indent = ' '.repeat(indentLevel * 4);
  let modifiers = '';
  
  // Apply frame modifier if dimensions exist
  if (node.layout?.dimensions) {
    const dimensions = node.layout.dimensions;
    if (dimensions.width && dimensions.height) {
      if (useResponsiveLayout) {
        modifiers += `${indent}    .responsiveFrame(smallWidth: ${dimensions.width}, smallHeight: ${dimensions.height})\n`;
      } else {
        modifiers += `${indent}    .frame(width: ${dimensions.width}, height: ${dimensions.height})\n`;
      }
    } else if (dimensions.width) {
      if (useResponsiveLayout) {
        modifiers += `${indent}    .responsiveFrame(smallWidth: ${dimensions.width})\n`;
      } else {
        modifiers += `${indent}    .frame(width: ${dimensions.width})\n`;
      }
    } else if (dimensions.height) {
      if (useResponsiveLayout) {
        modifiers += `${indent}    .responsiveFrame(smallHeight: ${dimensions.height})\n`;
      } else {
        modifiers += `${indent}    .frame(height: ${dimensions.height})\n`;
      }
    }
  }
  
  // Apply padding if exists
  if (node.layout?.padding) {
    // Handle different padding formats
    if (typeof node.layout.padding === 'string') {
      const paddingValue = parseInt(node.layout.padding.replace('px', ''));
      
      // Try to use spacing token if available
      const spacingToken = tokens.spacing.find(s => s.value === paddingValue);
      if (spacingToken) {
        modifiers += `${indent}    .padding(DesignTokens.Spacing.${spacingToken.name})\n`;
      } else if (useResponsiveLayout) {
        modifiers += `${indent}    .responsivePadding(${paddingValue})\n`;
      } else {
        modifiers += `${indent}    .padding(${paddingValue})\n`;
      }
    } else if (typeof node.layout.padding === 'object') {
      // Handle individual edge padding
      const { top, right, bottom, left } = node.layout.padding;
      if (top === right && right === bottom && bottom === left && top !== undefined) {
        // All sides equal
        // Try to use spacing token if available
        const spacingToken = tokens.spacing.find(s => s.value === top);
        if (spacingToken) {
          modifiers += `${indent}    .padding(DesignTokens.Spacing.${spacingToken.name})\n`;
        } else if (useResponsiveLayout) {
          modifiers += `${indent}    .responsivePadding(${top})\n`;
        } else {
          modifiers += `${indent}    .padding(${top})\n`;
        }
      } else {
        // Different padding for different edges
        const edges = [];
        if (top) {
          const topToken = tokens.spacing.find(s => s.value === top);
          edges.push(`.top, ${topToken ? `DesignTokens.Spacing.${topToken.name}` : top}`);
        }
        if (right) {
          const rightToken = tokens.spacing.find(s => s.value === right);
          edges.push(`.trailing, ${rightToken ? `DesignTokens.Spacing.${rightToken.name}` : right}`);
        }
        if (bottom) {
          const bottomToken = tokens.spacing.find(s => s.value === bottom);
          edges.push(`.bottom, ${bottomToken ? `DesignTokens.Spacing.${bottomToken.name}` : bottom}`);
        }
        if (left) {
          const leftToken = tokens.spacing.find(s => s.value === left);
          edges.push(`.leading, ${leftToken ? `DesignTokens.Spacing.${leftToken.name}` : left}`);
        }
        
        if (edges.length > 0) {
          edges.forEach(edge => {
            modifiers += `${indent}    .padding(${edge})\n`;
          });
        }
      }
    }
  }
  
  // Apply background color if exists and not already handled (like for shapes)
  if (node.type !== 'RECTANGLE' && node.type !== 'ELLIPSE' && node.style?.fills && node.style.fills.length > 0) {
    const fill = node.style.fills[0];
    if (fill.type === 'SOLID' && fill.color) {
      const color = getTokenizedColor(fill.color, fill.opacity, tokens);
      modifiers += `${indent}    .background(${color})\n`;
    } else if (fill.type === 'GRADIENT_LINEAR' && fill.gradientStops) {
      const gradientCode = getLinearGradientCode(fill, tokens);
      modifiers += `${indent}    .background(${gradientCode})\n`;
    }
  }
  
  // Apply corner radius if exists and not already handled
  if (node.type !== 'RECTANGLE' && node.style?.cornerRadius) {
    modifiers += `${indent}    .cornerRadius(${node.style.cornerRadius})\n`;
  }
  
  // Apply shadow if exists
  if (node.effects?.shadows && node.effects.shadows.length > 0) {
    const shadow = node.effects.shadows[0];
    
    // Try to use shadow token if available
    if (shadow.color) {
      const r = Math.round(shadow.color.r * 255);
      const g = Math.round(shadow.color.g * 255);
      const b = Math.round(shadow.color.b * 255);
      const a = shadow.opacity !== undefined ? shadow.opacity : (shadow.color.a !== undefined ? shadow.color.a : 0.3);
      const x = shadow.offset?.x || 0;
      const y = shadow.offset?.y || 0;
      const blur = shadow.radius || 5;
      const spread = shadow.spread;
      
      // Look for matching shadow token
      const shadowToken = tokens.shadows.find(s => 
        s.x === x && s.y === y && s.blur === blur && 
        (spread === undefined || s.spread === spread)
      );
      
      if (shadowToken) {
        modifiers += `${indent}    .shadow(DesignTokens.Shadows.${shadowToken.name})\n`;
      } else {
        const color = getTokenizedColor(shadow.color, shadow.opacity, tokens);
        modifiers += `${indent}    .shadow(color: ${color}, radius: ${blur}, x: ${x}, y: ${y})\n`;
      }
    }
  }
  
  // Apply opacity if exists
  if (node.style?.opacity !== undefined && node.style.opacity < 1) {
    modifiers += `${indent}    .opacity(${node.style.opacity})\n`;
  }
  
  // Apply position if absolute
  if (node.layout?.position === 'absolute' && node.layout.locationRelativeToParent) {
    const x = node.layout.locationRelativeToParent.x;
    const y = node.layout.locationRelativeToParent.y;
    modifiers += `${indent}    .position(x: ${x}, y: ${y})\n`;
  }
  
  // Apply rotation if exists
  if (node.style?.rotation) {
    const degrees = node.style.rotation;
    modifiers += `${indent}    .rotationEffect(.degrees(${degrees}))\n`;
  }
  
  // Apply border/stroke if exists
  if (node.style?.strokes && node.style.strokes.length > 0 && node.type !== 'LINE') {
    const stroke = node.style.strokes[0];
    if (stroke.type === 'SOLID' && stroke.color) {
      const color = getTokenizedColor(stroke.color, stroke.opacity, tokens);
      const weight = node.style.strokeWeight || 1;
      modifiers += `${indent}    .overlay(\n`;
      modifiers += `${indent}        RoundedRectangle(cornerRadius: ${node.style?.cornerRadius || 0})\n`;
      modifiers += `${indent}            .stroke(${color}, lineWidth: ${weight})\n`;
      modifiers += `${indent}    )\n`;
    }
  }
  
  return modifiers;
}

function applyLinearGradient(fill: any, indentLevel: number, tokens: DesignTokens): string {
  const indent = ' '.repeat(indentLevel * 4);
  const gradientCode = getLinearGradientCode(fill, tokens);
  return `${indent}    .fill(${gradientCode})\n`;
}

function getLinearGradientCode(fill: any, tokens: DesignTokens): string {
  // Extract gradient stops
  const stops = fill.gradientStops.map((stop: any) => {
    const color = getTokenizedColor(stop.color, stop.opacity, tokens);
    return `${color}`;
  });
  
  // Extract start and end points
  const startPoint = fill.gradientHandlePositions?.[0] || { x: 0, y: 0 };
  const endPoint = fill.gradientHandlePositions?.[1] || { x: 1, y: 1 };
  
  // Convert to SwiftUI UnitPoint
  const startUnitPoint = getUnitPoint(startPoint.x, startPoint.y);
  const endUnitPoint = getUnitPoint(endPoint.x, endPoint.y);
  
  // Build gradient code
  return `LinearGradient(
        colors: [${stops.join(', ')}],
        startPoint: ${startUnitPoint},
        endPoint: ${endUnitPoint}
    )`;
}

function getUnitPoint(x: number, y: number): string {
  // Convert coordinates to UnitPoint
  if (x === 0 && y === 0) return '.topLeading';
  if (x === 1 && y === 0) return '.topTrailing';
  if (x === 0 && y === 1) return '.bottomLeading';
  if (x === 1 && y === 1) return '.bottomTrailing';
  if (x === 0.5 && y === 0) return '.top';
  if (x === 0.5 && y === 1) return '.bottom';
  if (x === 0 && y === 0.5) return '.leading';
  if (x === 1 && y === 0.5) return '.trailing';
  if (x === 0.5 && y === 0.5) return '.center';
  
  // Custom point
  return `UnitPoint(x: ${x}, y: ${y})`;
}

function getSwiftUIAlignment(layout: SimplifiedLayout): string {
  if (layout.mode === 'column') {
    switch (layout.alignItems) {
      case 'flex-start': return '.leading';
      case 'flex-end': return '.trailing';
      case 'center': return '.center';
      case 'stretch': return '.center'; // SwiftUI doesn't have direct stretch equivalent
      default: return '.center';
    }
  } else if (layout.mode === 'row') {
    switch (layout.alignItems) {
      case 'flex-start': return '.top';
      case 'flex-end': return '.bottom';
      case 'center': return '.center';
      case 'stretch': return '.center'; // SwiftUI doesn't have direct stretch equivalent
      default: return '.center';
    }
  }
  return '.center';
}

function getSwiftUITextAlignment(alignment?: string): string | null {
  if (!alignment) return null;
  
  switch (alignment.toLowerCase()) {
    case 'left': return '.leading';
    case 'right': return '.trailing';
    case 'center': return '.center';
    case 'justified': return '.justified';
    default: return null;
  }
}

function getSwiftUIColor(color: any, opacity?: number): string {
  if (!color) return 'Color.clear';
  
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = opacity !== undefined ? opacity : (color.a !== undefined ? color.a : 1);
  
  // Check for standard colors first
  if (r === 255 && g === 0 && b === 0 && a === 1) return 'Color.red';
  if (r === 0 && g === 0 && b === 255 && a === 1) return 'Color.blue';
  if (r === 0 && g === 255 && b === 0 && a === 1) return 'Color.green';
  if (r === 0 && g === 0 && b === 0 && a === 1) return 'Color.black';
  if (r === 255 && g === 255 && b === 255 && a === 1) return 'Color.white';
  
  // Otherwise use RGB
  if (a < 1) {
    return `Color(red: ${(r/255).toFixed(3)}, green: ${(g/255).toFixed(3)}, blue: ${(b/255).toFixed(3)}, opacity: ${a.toFixed(3)})`;
  } else {
    return `Color(red: ${(r/255).toFixed(3)}, green: ${(g/255).toFixed(3)}, blue: ${(b/255).toFixed(3)})`;
  }
}

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

function generatePreviews(design: SimplifiedDesign): string {
  const viewName = sanitizeName(design.name);
  return `}\n\n#Preview {\n    ${viewName}View()\n}`;
}

// Helper function to get tokenized color
function getTokenizedColor(color: any, opacity: number | undefined, tokens: DesignTokens): string {
  if (!color) return 'Color.clear';
  
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = opacity !== undefined ? opacity : (color.a !== undefined ? color.a : 1);
  
  // Try to find matching color token
  const colorToken = tokens.colors.find(c => 
    c.rgba.r === r && c.rgba.g === g && c.rgba.b === b && 
    Math.abs(c.rgba.a - a) < 0.01 // Allow small difference in alpha
  );
  
  if (colorToken) {
    return `DesignTokens.Colors.${colorToken.name}`;
  }
  
  // Check for standard colors
  if (r === 255 && g === 0 && b === 0 && a === 1) return 'Color.red';
  if (r === 0 && g === 0 && b === 255 && a === 1) return 'Color.blue';
  if (r === 0 && g === 255 && b === 0 && a === 1) return 'Color.green';
  if (r === 0 && g === 0 && b === 0 && a === 1) return 'Color.black';
  if (r === 255 && g === 255 && b === 255 && a === 1) return 'Color.white';
  
  // Otherwise use RGB
  if (a < 1) {
    return `Color(red: ${(r/255).toFixed(3)}, green: ${(g/255).toFixed(3)}, blue: ${(b/255).toFixed(3)}, opacity: ${a.toFixed(3)})`;
  } else {
    return `Color(red: ${(r/255).toFixed(3)}, green: ${(g/255).toFixed(3)}, blue: ${(b/255).toFixed(3)})`;
  }
} 