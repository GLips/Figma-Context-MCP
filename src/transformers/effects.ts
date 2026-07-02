import type {
  NodeSnapshot,
  SnapshotColor,
  SnapshotEffect,
  SnapshotVector,
} from "~/extractors/snapshot.js";
import { formatRGBAColor } from "~/transformers/style.js";
import { pixelRound } from "~/utils/common.js";

export type SimplifiedEffects = {
  boxShadow?: string;
  filter?: string;
  backdropFilter?: string;
  textShadow?: string;
};

// DROP_SHADOW/INNER_SHADOW always carry an offset and color (the adapter decodes
// them from Figma's shadow effects, which require both). The snapshot types them
// optional to accommodate blurs, so narrow here to keep the simplifiers total.
type SnapshotShadowEffect = SnapshotEffect & { offset: SnapshotVector; color: SnapshotColor };

export function buildSimplifiedEffects(n: NodeSnapshot): SimplifiedEffects {
  if (!n.effects) return {};
  const effects = n.effects.filter((e) => e.visible);

  // Handle drop and inner shadows (both go into CSS box-shadow)
  const dropShadows = effects
    .filter((e): e is SnapshotShadowEffect => e.type === "DROP_SHADOW")
    .map(simplifyDropShadow);

  const innerShadows = effects
    .filter((e): e is SnapshotShadowEffect => e.type === "INNER_SHADOW")
    .map(simplifyInnerShadow);

  const boxShadow = [...dropShadows, ...innerShadows].join(", ");

  // Handle blur effects - separate by CSS property. A zero-radius blur is a
  // no-op, so drop it entirely rather than emit a dead `blur(0px)`.
  // Layer blurs use the CSS 'filter' property
  const filterBlurValues = effects
    .filter((e) => e.type === "LAYER_BLUR" && e.radius > 0)
    .map(simplifyBlur)
    .join(" ");

  // Background blurs use the CSS 'backdrop-filter' property
  const backdropFilterValues = effects
    .filter((e) => e.type === "BACKGROUND_BLUR" && e.radius > 0)
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

function simplifyDropShadow(effect: SnapshotShadowEffect) {
  return `${effect.offset.x}px ${effect.offset.y}px ${effect.radius}px ${effect.spread ?? 0}px ${formatRGBAColor(effect.color)}`;
}

function simplifyInnerShadow(effect: SnapshotShadowEffect) {
  return `inset ${effect.offset.x}px ${effect.offset.y}px ${effect.radius}px ${effect.spread ?? 0}px ${formatRGBAColor(effect.color)}`;
}

function simplifyBlur(effect: SnapshotEffect) {
  // Figma's blur radius is ~2x the CSS blur() radius — verified by direct CSS
  // test and corroborated by Figma's own Dev Mode output (a Figma blur of 32
  // renders as CSS blur(16px)). Halve it so the emitted value matches CSS.
  return `blur(${pixelRound(effect.radius / 2)}px)`;
}
