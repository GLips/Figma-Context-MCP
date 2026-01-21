import type { Node as FigmaDocumentNode } from "@figma/rest-api-spec";
import { hasValue } from "~/utils/identity.js";

export function buildSimplifiedText(n: FigmaDocumentNode): string | undefined {
  if (!hasValue("characters", n) || !n.characters) {
    return undefined;
  }

  const characters = n.characters;
  const characterStyleOverrides = (n as any).characterStyleOverrides || [];
  const styleOverrideTable = (n as any).styleOverrideTable || {};
  const baseStyle = (n as any).style || {};

  // If there are no overrides, return plain text
  if (characterStyleOverrides.length === 0) {
    return characters;
  }

  let html = "";
  let currentStyle = null;
  let currentText = "";

  for (let i = 0; i < characters.length; i++) {
    const char = characters[i];
    const styleId = characterStyleOverrides[i];
    
    // Get the style for this character (lucky character aye...)
    let charStyle = { ...baseStyle };
    
    // If styleId > 0, merge with override (0 = use base style, the starting default)
    if (styleId && styleId > 0 && styleOverrideTable[styleId]) {
      charStyle = { ...charStyle, ...styleOverrideTable[styleId] };
    }

    // Create style object for comparison
    const cssStyle = {
      fontWeight: charStyle.fontWeight,
      fontStyle: charStyle.fontStyle,
      textDecoration: charStyle.textDecoration
    };

    // If style changed, output previous span and start new one
    if (JSON.stringify(cssStyle) !== JSON.stringify(currentStyle)) {
      if (currentText) {
        html += createSpan(currentText, currentStyle);
      }
      currentStyle = cssStyle;
      currentText = char;
    } else {
      currentText += char;
    }
  }

  // Output final span
  if (currentText) {
    html += createSpan(currentText, currentStyle);
  }

  return html;
}

function createSpan(text: string, style: any): string {
  if (!style) {
    return text;
  }

  let cssStyles = [];
  if (style.fontWeight) cssStyles.push(`font-weight: ${style.fontWeight}`);
  if (style.fontStyle === "ITALIC") cssStyles.push(`font-style: italic`);
  if (style.textDecoration === "UNDERLINE") cssStyles.push(`text-decoration: underline`);

  if (cssStyles.length === 0) {
    return text;
  }

  return `<span style="${cssStyles.join('; ')}">${text}</span>`;
}




