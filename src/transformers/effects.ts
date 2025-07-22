import type {
  DropShadowEffect,
  InnerShadowEffect,
  BlurEffect,
  Node as FigmaDocumentNode,
} from "@figma/rest-api-spec";
import { formatRGBAColor } from "~/transformers/style.js";
import { hasValue } from "~/utils/identity.js";

export type SimplifiedEffects = {
  boxShadow?: string;
  filter?: string;
  backdropFilter?: string;
  textShadow?: string;
};

export function buildSimplifiedEffects(n: FigmaDocumentNode): SimplifiedEffects {
  if (!hasValue("effects", n)) return {};
  const effects = n.effects.filter((e) => e.visible);

  // Handle drop and inner shadows (both go into CSS box-shadow)
  const dropShadows = effects
    .filter((e): e is DropShadowEffect => e.type === "DROP_SHADOW")
    .map(simplifyDropShadow);

  const innerShadows = effects
    .filter((e): e is InnerShadowEffect => e.type === "INNER_SHADOW")
    .map(simplifyInnerShadow);

  const boxShadow = [...dropShadows, ...innerShadows].join(", ");

  // Handle blur effects - separate by CSS property
  // Layer blurs use the CSS 'filter' property
  const filterBlurValues = effects
    .filter((e): e is BlurEffect => e.type === "LAYER_BLUR")
    .map(simplifyBlur)
    .join(" ");

  // Background blurs use the CSS 'backdrop-filter' property
  const backdropFilterValues = effects
    .filter((e): e is BlurEffect => e.type === "BACKGROUND_BLUR")
    .map(simplifyBlur)
    .join(" ");

  const result: SimplifiedEffects = {};

  if (boxShadow) {
    if (n.type === "TEXT") {
      result.textShadow = boxShadow;
    } else {
      result.boxShadow = boxShadow;
    }
  }
  if (filterBlurValues) result.filter = filterBlurValues;
  if (backdropFilterValues) result.backdropFilter = backdropFilterValues;

  return result;
}

function simplifyDropShadow(effect: DropShadowEffect) {
  return `${effect.offset.x}px ${effect.offset.y}px ${effect.radius}px ${effect.spread ?? 0}px ${formatRGBAColor(effect.color)}`;
}

function simplifyInnerShadow(effect: InnerShadowEffect) {
  return `inset ${effect.offset.x}px ${effect.offset.y}px ${effect.radius}px ${effect.spread ?? 0}px ${formatRGBAColor(effect.color)}`;
}

function simplifyBlur(effect: BlurEffect) {
  return `blur(${effect.radius}px)`;
}
