import type { Paint, Vector, RGBA } from "@figma/rest-api-spec";
import { formatRGBAColor } from "./color.js";

export type SimplifiedGradientFill = {
  type: "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND";
  gradient: string;
};

type GradientPaint = Extract<
  Paint,
  { type: "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND" }
>;

type GradientStop = { position: number; color: RGBA };

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

function mapGradientStops(
  gradient: GradientPaint,
  elementBounds: { width: number; height: number } = { width: 1, height: 1 },
  paintOpacity: number = 1,
): { stops: string; cssGeometry: string } {
  const handles = gradient.gradientHandlePositions;
  if (!handles || handles.length < 2) {
    return { stops: formatStops(gradient.gradientStops, paintOpacity), cssGeometry: "0deg" };
  }

  const [handle1, handle2, handle3] = handles;

  switch (gradient.type) {
    case "GRADIENT_LINEAR": {
      return mapLinearGradient(
        gradient.gradientStops,
        handle1,
        handle2,
        elementBounds,
        paintOpacity,
      );
    }
    case "GRADIENT_RADIAL": {
      return mapRadialGradient(
        gradient.gradientStops,
        handle1,
        handle2,
        handle3,
        elementBounds,
        paintOpacity,
      );
    }
    case "GRADIENT_ANGULAR": {
      return mapAngularGradient(
        gradient.gradientStops,
        handle1,
        handle2,
        handle3,
        elementBounds,
        paintOpacity,
      );
    }
    case "GRADIENT_DIAMOND": {
      return mapDiamondGradient(
        gradient.gradientStops,
        handle1,
        handle2,
        handle3,
        elementBounds,
        paintOpacity,
      );
    }
    default: {
      return { stops: formatStops(gradient.gradientStops, paintOpacity), cssGeometry: "0deg" };
    }
  }
}

/**
 * Map linear gradient from Figma handles to CSS
 */
function mapLinearGradient(
  gradientStops: GradientStop[],
  start: Vector,
  end: Vector,
  _elementBounds: { width: number; height: number },
  paintOpacity: number = 1,
): { stops: string; cssGeometry: string } {
  // Calculate the gradient line in element space
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const gradientLength = Math.sqrt(dx * dx + dy * dy);

  // Handle degenerate case
  if (gradientLength === 0) {
    return { stops: formatStops(gradientStops, paintOpacity), cssGeometry: "0deg" };
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
  center: Vector,
  _edge: Vector,
  _widthHandle: Vector,
  _elementBounds: { width: number; height: number },
  paintOpacity: number = 1,
): { stops: string; cssGeometry: string } {
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
  center: Vector,
  angleHandle: Vector,
  _widthHandle: Vector,
  _elementBounds: { width: number; height: number },
  paintOpacity: number = 1,
): { stops: string; cssGeometry: string } {
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
  center: Vector,
  _edge: Vector,
  _widthHandle: Vector,
  _elementBounds: { width: number; height: number },
  paintOpacity: number = 1,
): { stops: string; cssGeometry: string } {
  const centerX = Math.round(center.x * 100);
  const centerY = Math.round(center.y * 100);

  return {
    stops: formatStops(gradientStops, paintOpacity),
    cssGeometry: `ellipse at ${centerX}% ${centerY}%`,
  };
}

/**
 * Convert a Figma gradient to CSS gradient syntax.
 */
export function convertGradientToCss(gradient: GradientPaint): string {
  // The paint's overall opacity multiplies into each stop's own alpha (the two stack).
  const paintOpacity = gradient.opacity ?? 1;

  // Sort stops by position to ensure proper order
  const sortedGradient = {
    ...gradient,
    gradientStops: [...gradient.gradientStops].sort((a, b) => a.position - b.position),
  };

  // Map gradient stops using handle-based geometry
  const { stops, cssGeometry } = mapGradientStops(
    sortedGradient,
    { width: 1, height: 1 },
    paintOpacity,
  );

  switch (gradient.type) {
    case "GRADIENT_LINEAR": {
      return `linear-gradient(${cssGeometry}, ${stops})`;
    }

    case "GRADIENT_RADIAL": {
      return `radial-gradient(${cssGeometry}, ${stops})`;
    }

    case "GRADIENT_ANGULAR": {
      return `conic-gradient(${cssGeometry}, ${stops})`;
    }

    case "GRADIENT_DIAMOND": {
      return `radial-gradient(${cssGeometry}, ${stops})`;
    }

    default:
      return `linear-gradient(0deg, ${stops})`;
  }
}
