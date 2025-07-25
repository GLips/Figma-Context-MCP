import type {
  DropShadowEffect,
  InnerShadowEffect,
  BlurEffect,
  TextureEffect,
  NoiseEffect,
  BlendMode,
  Node as FigmaDocumentNode,
} from "@figma/rest-api-spec";
import { formatRGBAColor } from "~/transformers/style.js";
import { hasValue } from "~/utils/identity.js";

export type SimplifiedEffects = {
  boxShadow?: string;
  filter?: string;
  backdropFilter?: string;
  textShadow?: string;
  // textureEffect?: string;
  // noiseEffect?: string;
  // additionalStyles?: Record<string, string>;
};

export function buildSimplifiedEffects(n: FigmaDocumentNode): SimplifiedEffects {
  if (!hasValue("effects", n)) return {};
  const effects = n.effects.filter((e) => "visible" in e ? e.visible : true);

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

  // TODO: handle texture and noise effects

  // // Handle texture effects
  // const textureEffects = effects
  //   .filter((e): e is TextureEffect => e.type === "TEXTURE");

  // // Handle noise effects
  // const noiseEffects = effects
  //   .filter((e): e is NoiseEffect => e.type === "NOISE");

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
  
  // // handle texture effects
  // if (textureEffects.length > 0) {
  //   result.textureEffect = textureEffects.map(simplifyTextureEffect).join(", ");
  //   result.additionalStyles = {
  //     ...result.additionalStyles,
  //     ...generateTextureEffectStyles(textureEffects),
  //   };
  // }

  // // handle noise effects
  // if (noiseEffects.length > 0) {
  //   result.noiseEffect = noiseEffects.map(simplifyNoiseEffect).join(", ");
  //   result.additionalStyles = {
  //     ...result.additionalStyles,
  //     ...generateNoiseEffectStyles(noiseEffects),
  //   };
  // }

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

function simplifyTextureEffect(effect: TextureEffect): string {
  return `texture(size: ${effect.noiseSize}px, radius: ${effect.radius}px, clip: ${effect.clipToShape})`;
}

function simplifyNoiseEffect(effect: NoiseEffect): string {
  const baseInfo = `noise(type: ${effect.noiseType}, size: ${effect.noiseSize}px, density: ${effect.density})`;
  
  if (effect.noiseType === "MULTITONE" && "opacity" in effect) {
    return `${baseInfo}, opacity: ${effect.opacity}`;
  }
  
  if (effect.noiseType === "DUOTONE" && "secondaryColor" in effect) {
    return `${baseInfo}, secondary: ${formatRGBAColor(effect.secondaryColor)}`;
  }
  
  return baseInfo;
}

function generateTextureEffectStyles(effects: TextureEffect[]): Record<string, string> {
  const styles: Record<string, string> = {};
  
  effects.forEach((effect, index) => {
    const className = `texture-effect-${index}`;
    
    styles[className] = `
      position: relative;
      ${effect.clipToShape ? 'overflow: hidden;' : ''}
      
      &::after {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-image: 
          radial-gradient(circle at 25% 25%, rgba(0,0,0,0.1) 1px, transparent 1px),
          radial-gradient(circle at 75% 75%, rgba(0,0,0,0.1) 1px, transparent 1px),
          radial-gradient(circle at 50% 15%, rgba(0,0,0,0.08) 1px, transparent 1px),
          radial-gradient(circle at 85% 50%, rgba(0,0,0,0.12) 1px, transparent 1px);
        background-size: ${effect.noiseSize}px ${effect.noiseSize}px;
        ${effect.radius > 0 ? `filter: blur(${effect.radius}px);` : ''}
        pointer-events: none;
        mix-blend-mode: multiply;
      }
    `;
  });
  
  return styles;
}

function generateNoiseEffectStyles(effects: NoiseEffect[]): Record<string, string> {
  const styles: Record<string, string> = {};
  
  effects.forEach((effect, index) => {
    const className = `noise-effect-${index}`;
    
    let backgroundImage = '';
    let finalOpacity = effect.density;
    let blendMode = 'multiply';
    
    // 获取混合模式字符串（需要将 BlendMode 枚举转换为 CSS 值）
    const cssBlendMode = getBlendModeCSS(effect.blendMode);
    
    switch (effect.noiseType) {
      case 'MONOTONE':
        // 单色噪点效果
        backgroundImage = `
          radial-gradient(circle at 20% 50%, rgba(0,0,0,0.15) 1px, transparent 1px),
          radial-gradient(circle at 60% 20%, rgba(0,0,0,0.12) 1px, transparent 1px),
          radial-gradient(circle at 80% 80%, rgba(0,0,0,0.18) 1px, transparent 1px),
          radial-gradient(circle at 40% 70%, rgba(0,0,0,0.1) 1px, transparent 1px)`;
        blendMode = cssBlendMode || 'multiply';
        break;
        
      case 'MULTITONE':
        // 多色噪点效果
        backgroundImage = `
          radial-gradient(circle at 25% 25%, rgba(255,0,0,0.1) 1px, transparent 1px),
          radial-gradient(circle at 75% 25%, rgba(0,255,0,0.1) 1px, transparent 1px),
          radial-gradient(circle at 25% 75%, rgba(0,0,255,0.1) 1px, transparent 1px),
          radial-gradient(circle at 75% 75%, rgba(255,255,0,0.1) 1px, transparent 1px),
          radial-gradient(circle at 50% 50%, rgba(255,0,255,0.1) 1px, transparent 1px)`;
        if ("opacity" in effect) {
          finalOpacity = effect.density * effect.opacity;
        }
        blendMode = cssBlendMode || 'overlay';
        break;
        
      case 'DUOTONE':
        // 双色噪点效果
        const secondaryColor = ("secondaryColor" in effect) 
          ? formatRGBAColor(effect.secondaryColor)
          : 'rgba(255,255,255,0.1)';
        const secondaryColorDimmed = secondaryColor.replace(/[\d.]+\)$/, '0.08)');
        
        backgroundImage = `
          radial-gradient(circle at 30% 30%, rgba(0,0,0,0.15) 1px, transparent 1px),
          radial-gradient(circle at 70% 30%, rgba(0,0,0,0.12) 1px, transparent 1px),
          radial-gradient(circle at 30% 70%, ${secondaryColor} 1px, transparent 1px),
          radial-gradient(circle at 70% 70%, ${secondaryColorDimmed} 1px, transparent 1px)`;
        blendMode = cssBlendMode || 'soft-light';
        break;
        
      default:
        // 默认单色效果
        backgroundImage = `
          radial-gradient(circle at 25% 25%, rgba(0,0,0,0.1) 1px, transparent 1px),
          radial-gradient(circle at 75% 75%, rgba(0,0,0,0.1) 1px, transparent 1px)`;
        blendMode = cssBlendMode || 'multiply';
    }
    
    const backgroundSizes = [
      `${effect.noiseSize}px ${effect.noiseSize}px`,
      `${Math.round(effect.noiseSize * 1.5)}px ${Math.round(effect.noiseSize * 1.5)}px`,
      `${Math.round(effect.noiseSize * 0.8)}px ${Math.round(effect.noiseSize * 0.8)}px`,
      `${Math.round(effect.noiseSize * 1.2)}px ${Math.round(effect.noiseSize * 1.2)}px`
    ];
    
    if (effect.noiseType === 'MULTITONE') {
      backgroundSizes.push(`${Math.round(effect.noiseSize * 0.6)}px ${Math.round(effect.noiseSize * 0.6)}px`);
    }
    
    styles[className] = `
      position: relative;
      
      &::after {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-image: ${backgroundImage};
        background-size: ${backgroundSizes.join(', ')};
        opacity: ${finalOpacity};
        mix-blend-mode: ${blendMode};
        pointer-events: none;
      }
    `;
  });
  
  return styles;
}

// 将 Figma BlendMode 转换为 CSS mix-blend-mode 值
function getBlendModeCSS(blendMode: BlendMode): string {
  const blendModeMap: Record<string, string> = {
    'NORMAL': 'normal',
    'MULTIPLY': 'multiply',
    'SCREEN': 'screen',
    'OVERLAY': 'overlay',
    'SOFT_LIGHT': 'soft-light',
    'HARD_LIGHT': 'hard-light',
    'COLOR_DODGE': 'color-dodge',
    'COLOR_BURN': 'color-burn',
    'DARKEN': 'darken',
    'LIGHTEN': 'lighten',
    'DIFFERENCE': 'difference',
    'EXCLUSION': 'exclusion',
    'HUE': 'hue',
    'SATURATION': 'saturation',
    'COLOR': 'color',
    'LUMINOSITY': 'luminosity',
  };
  
  return blendModeMap[blendMode] || 'normal';
}
