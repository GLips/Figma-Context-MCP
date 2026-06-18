import type { Paint, RGBA, Vector } from "@figma/rest-api-spec";
import { formatRGBAColor } from "./color.js";

export type SimplifiedGradientFill = {
  type: "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND";
  gradient: string;
};

type GradientPaint = Extract<
  Paint,
  {
    type: "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND";
  }
>;

type GradientStop = { position: number; color: RGBA };

type GradientGeometry = { stops: string; cssGeometry: string };

type GradientMapper = (
  gradientStops: GradientStop[],
  handles: Vector[],
  paintOpacity: number,
) => GradientGeometry;

/**
 * Format stops as CSS `<color> <pos>%` segments at their original positions.
 * `paintOpacity` multiplies each stop's `color.a` (via `formatRGBAColor`).
 * Mappers that remap positions (e.g. linear's extended-line case) format inline.
 */
function formatStops(stops: GradientStop[], paintOpacity: number): string {
  return stops
    .map(
      ({ position, color }) =>
        `${formatRGBAColor(color, paintOpacity)} ${Math.round(position * 100)}%`,
    )
    .join(", ");
}

/**
 * Map linear gradient from Figma handles to CSS
 */
function mapLinearGradient(
  gradientStops: GradientStop[],
  handles: Vector[],
  paintOpacity: number,
): GradientGeometry {
  const [start, end] = handles;

  // Calculate the gradient line in element space
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const gradientLength = Math.sqrt(dx * dx + dy * dy);

  // Handle degenerate case
  if (gradientLength === 0) {
    return {
      stops: formatStops(gradientStops, paintOpacity),
      cssGeometry: "0deg",
    };
  }

  // Calculate angle for CSS
  const angle = Math.atan2(dy, dx) * (180 / Math.PI) + 90;

  // Find where the extended gradient line intersects the element boundaries
  const extendedIntersections = findExtendedLineIntersections(start, end);

  if (extendedIntersections.length >= 2) {
    // The gradient line extended to fill the element
    const fullLineStart = Math.min(extendedIntersections[0], extendedIntersections[1]);
    const fullLineEnd = Math.max(extendedIntersections[0], extendedIntersections[1]);
    // Map gradient stops from the Figma line segment to the full CSS line
    const mappedStops = gradientStops.map(({ position, color }) => {
      const cssColor = formatRGBAColor(color, paintOpacity);

      // Position along the Figma gradient line (0 = start handle, 1 = end handle)
      const figmaLinePosition = position;

      // The Figma line spans from t=0 to t=1
      // The full extended line spans from fullLineStart to fullLineEnd
      // Map the figma position to the extended line
      const tOnExtendedLine = figmaLinePosition * (1 - 0) + 0; // This is just figmaLinePosition
      const extendedPosition = (tOnExtendedLine - fullLineStart) / (fullLineEnd - fullLineStart);
      const clampedPosition = Math.max(0, Math.min(1, extendedPosition));

      return `${cssColor} ${Math.round(clampedPosition * 100)}%`;
    });

    return {
      stops: mappedStops.join(", "),
      cssGeometry: `${Math.round(angle)}deg`,
    };
  }

  // Fallback to simple gradient if intersection calculation fails
  return {
    stops: formatStops(gradientStops, paintOpacity),
    cssGeometry: `${Math.round(angle)}deg`,
  };
}

/**
 * Find where the extended gradient line intersects with the element boundaries
 */
function findExtendedLineIntersections(start: Vector, end: Vector): number[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;

  // Handle degenerate case
  if (Math.abs(dx) < 1e-10 && Math.abs(dy) < 1e-10) {
    return [];
  }

  const intersections: number[] = [];

  // Check intersection with each edge of the unit square [0,1] x [0,1]
  // Top edge (y = 0)
  if (Math.abs(dy) > 1e-10) {
    const t = -start.y / dy;
    const x = start.x + t * dx;
    if (x >= 0 && x <= 1) {
      intersections.push(t);
    }
  }

  // Bottom edge (y = 1)
  if (Math.abs(dy) > 1e-10) {
    const t = (1 - start.y) / dy;
    const x = start.x + t * dx;
    if (x >= 0 && x <= 1) {
      intersections.push(t);
    }
  }

  // Left edge (x = 0)
  if (Math.abs(dx) > 1e-10) {
    const t = -start.x / dx;
    const y = start.y + t * dy;
    if (y >= 0 && y <= 1) {
      intersections.push(t);
    }
  }

  // Right edge (x = 1)
  if (Math.abs(dx) > 1e-10) {
    const t = (1 - start.x) / dx;
    const y = start.y + t * dy;
    if (y >= 0 && y <= 1) {
      intersections.push(t);
    }
  }

  // Remove duplicates and sort
  const uniqueIntersections = [
    ...new Set(intersections.map((t) => Math.round(t * 1000000) / 1000000)),
  ];
  return uniqueIntersections.sort((a, b) => a - b);
}

/**
 * Map radial gradient from Figma handles to CSS
 */
function mapRadialGradient(
  gradientStops: GradientStop[],
  handles: Vector[],
  paintOpacity: number,
): GradientGeometry {
  const [center] = handles;
  const centerX = Math.round(center.x * 100);
  const centerY = Math.round(center.y * 100);

  return {
    stops: formatStops(gradientStops, paintOpacity),
    cssGeometry: `circle at ${centerX}% ${centerY}%`,
  };
}

/**
 * Map angular gradient from Figma handles to CSS
 */
function mapAngularGradient(
  gradientStops: GradientStop[],
  handles: Vector[],
  paintOpacity: number,
): GradientGeometry {
  const [center, angleHandle] = handles;
  const centerX = Math.round(center.x * 100);
  const centerY = Math.round(center.y * 100);

  const angle =
    Math.atan2(angleHandle.y - center.y, angleHandle.x - center.x) * (180 / Math.PI) + 90;

  return {
    stops: formatStops(gradientStops, paintOpacity),
    cssGeometry: `from ${Math.round(angle)}deg at ${centerX}% ${centerY}%`,
  };
}

/**
 * Map diamond gradient from Figma handles to CSS (approximate with ellipse)
 */
function mapDiamondGradient(
  gradientStops: GradientStop[],
  handles: Vector[],
  paintOpacity: number,
): GradientGeometry {
  const [center] = handles;
  const centerX = Math.round(center.x * 100);
  const centerY = Math.round(center.y * 100);

  return {
    stops: formatStops(gradientStops, paintOpacity),
    cssGeometry: `ellipse at ${centerX}% ${centerY}%`,
  };
}

/**
 * Per-type dispatch: how to compute each gradient's geometry + stops, and which
 * CSS function wraps the result. Keying both halves off `gradient.type` in one
 * table keeps the geometry mapper and its CSS wrapper from drifting apart — they
 * were previously two separate switches that had to be kept in sync by hand.
 */
const GRADIENT_RENDERERS: Record<
  GradientPaint["type"],
  { map: GradientMapper; wrap: (geometry: string, stops: string) => string }
> = {
  GRADIENT_LINEAR: {
    map: mapLinearGradient,
    wrap: (g, s) => `linear-gradient(${g}, ${s})`,
  },
  GRADIENT_RADIAL: {
    map: mapRadialGradient,
    wrap: (g, s) => `radial-gradient(${g}, ${s})`,
  },
  GRADIENT_ANGULAR: {
    map: mapAngularGradient,
    wrap: (g, s) => `conic-gradient(${g}, ${s})`,
  },
  GRADIENT_DIAMOND: {
    map: mapDiamondGradient,
    wrap: (g, s) => `radial-gradient(${g}, ${s})`,
  },
};

/**
 * Convert a Figma gradient to CSS gradient syntax.
 */
export function convertGradientToCss(gradient: GradientPaint): string {
  // The paint's overall opacity multiplies into each stop's own alpha (the two stack).
  const paintOpacity = gradient.opacity ?? 1;
  const sortedStops = [...gradient.gradientStops].sort((a, b) => a.position - b.position);
  const { map, wrap } = GRADIENT_RENDERERS[gradient.type];

  // Without two handles there's no gradient line to map; emit stops at their raw
  // positions and let the per-type wrapper supply a neutral "0deg" geometry.
  const handles = gradient.gradientHandlePositions;
  if (!handles || handles.length < 2) {
    return wrap("0deg", formatStops(sortedStops, paintOpacity));
  }

  const { stops, cssGeometry } = map(sortedStops, handles, paintOpacity);
  return wrap(cssGeometry, stops);
}
