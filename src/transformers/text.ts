import type { Node as FigmaDocumentNode } from "@figma/rest-api-spec";
import { hasValue, isTruthy } from "~/utils/identity.js";

export type SimplifiedTextStyle = Partial<{
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  lineHeight: string;
  letterSpacing: string;
  textCase: string;
  textAlignHorizontal: string;
  textAlignVertical: string;
}>;

export function isTextNode(
  n: FigmaDocumentNode,
): n is Extract<FigmaDocumentNode, { type: "TEXT" }> {
  return n.type === "TEXT";
}

export function hasTextStyle(
  n: FigmaDocumentNode,
): n is FigmaDocumentNode & { style: Extract<FigmaDocumentNode, { style: any }>["style"] } {
  return hasValue("style", n) && Object.keys(n.style).length > 0;
}

// Keep other simple properties directly
export function extractNodeText(n: FigmaDocumentNode) {
  if (hasValue("characters", n, isTruthy)) {
    return n.characters;
  }
}

export function extractTextStyle(n: FigmaDocumentNode) {
  if (hasTextStyle(n)) {
    const style = n.style;
    const textStyle: SimplifiedTextStyle = {
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      fontSize: style.fontSize,
      lineHeight:
        "lineHeightPx" in style && style.lineHeightPx && style.fontSize
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
    return textStyle;
  }
}
