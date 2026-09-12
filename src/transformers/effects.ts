import type {
  DropShadowEffect,
  InnerShadowEffect,
  BlurEffect,
  Node as FigmaDocumentNode,
} from "@figma/rest-api-spec";
import { formatRGBAColor } from "~/transformers/style.js";
import { hasValue } from "~/utils/identity.js";
import { pixelRound } from "~/utils/common.js";

export type SimplifiedEffects = {
  boxShadow?: string;
  filter?: string;
  backdropFilter?: string;
  textShadow?: string;
};

export function buildSimplifiedEffects(n: FigmaDocumentNode): SimplifiedEffects {
  if (!hasValue("effects", n)) return {};
  const effects = n.effects.filter((e) => e.visible);
  const isText = n.type === "TEXT";

  // CSS text-shadow supports neither spread nor inset; an unsupported entry
  // would invalidate the entire shadow list, including valid drop shadows.
  const dropShadows = effects
    .filter((e): e is DropShadowEffect => e.type === "DROP_SHADOW")
    .map((effect) => (isText ? simplifyTextShadow(effect) : simplifyDropShadow(effect)));

  const innerShadows = effects
    .filter((e): e is InnerShadowEffect => !isText && e.type === "INNER_SHADOW")
    .map(simplifyInnerShadow);

  const shadow = [...dropShadows, ...innerShadows].join(", ");

  // Handle blur effects - separate by CSS property. A zero-radius blur is a
  // no-op, so drop it entirely rather than emit a dead `blur(0px)`.
  // Layer blurs use the CSS 'filter' property
  const filterBlurValues = effects
    .filter((e): e is BlurEffect => e.type === "LAYER_BLUR" && e.radius > 0)
    .map(simplifyBlur)
    .join(" ");

  // Background blurs use the CSS 'backdrop-filter' property
  const backdropFilterValues = effects
    .filter((e): e is BlurEffect => e.type === "BACKGROUND_BLUR" && e.radius > 0)
    .map(simplifyBlur)
    .join(" ");

  const result: SimplifiedEffects = {};

  if (shadow) {
    if (isText) {
      result.textShadow = shadow;
    } else {
      result.boxShadow = shadow;
    }
  }
  if (filterBlurValues) result.filter = filterBlurValues;
  if (backdropFilterValues) result.backdropFilter = backdropFilterValues;

  return result;
}

function simplifyTextShadow(effect: DropShadowEffect) {
  return `${effect.offset.x}px ${effect.offset.y}px ${effect.radius}px ${formatRGBAColor(effect.color)}`;
}

function simplifyDropShadow(effect: DropShadowEffect) {
  return `${effect.offset.x}px ${effect.offset.y}px ${effect.radius}px ${effect.spread ?? 0}px ${formatRGBAColor(effect.color)}`;
}

function simplifyInnerShadow(effect: InnerShadowEffect) {
  return `inset ${effect.offset.x}px ${effect.offset.y}px ${effect.radius}px ${effect.spread ?? 0}px ${formatRGBAColor(effect.color)}`;
}

function simplifyBlur(effect: BlurEffect) {
  // Figma's blur radius is ~2x the CSS blur() radius — verified by direct CSS
  // test and corroborated by Figma's own Dev Mode output (a Figma blur of 32
  // renders as CSS blur(16px)). Halve it so the emitted value matches CSS.
  return `blur(${pixelRound(effect.radius / 2)}px)`;
}
