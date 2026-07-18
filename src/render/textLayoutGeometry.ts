import type { Point } from "../core/document";
import type { Rect } from "../core/layout";

export interface TextLayoutGeometry {
  readonly id: string;
  readonly placement: Point;
  readonly localVisualBounds: Rect;
}

export interface ProjectedTextLayoutGeometry {
  readonly id: string;
  readonly visualBounds: Rect;
  readonly touchBounds: Rect;
  readonly hitPriority: number;
}

function scalePlacedBounds(geometry: TextLayoutGeometry, screenScale: number): Rect {
  return {
    x: (geometry.placement.x + geometry.localVisualBounds.x) * screenScale,
    y: (geometry.placement.y + geometry.localVisualBounds.y) * screenScale,
    width: geometry.localVisualBounds.width * screenScale,
    height: geometry.localVisualBounds.height * screenScale,
  };
}

function expandAroundCenter(bounds: Rect, minimumSize: number): Rect {
  const width = Math.max(minimumSize, bounds.width);
  const height = Math.max(minimumSize, bounds.height);
  return {
    x: bounds.x - (width - bounds.width) / 2,
    y: bounds.y - (height - bounds.height) / 2,
    width,
    height,
  };
}

/** Maps layout geometry to screen points while preserving document draw order. */
export function projectTextLayoutGeometry(
  layouts: readonly TextLayoutGeometry[],
  screenScale: number,
  minimumTouchSize = 44,
): readonly ProjectedTextLayoutGeometry[] {
  if (!Number.isFinite(screenScale) || screenScale <= 0) {
    throw new Error("text layout screen scale must be a positive finite number");
  }
  if (!Number.isFinite(minimumTouchSize) || minimumTouchSize < 0) {
    throw new Error("minimum text touch size must be a non-negative finite number");
  }

  return Object.freeze(
    layouts.map((layout, hitPriority) => {
      const visualBounds = Object.freeze(scalePlacedBounds(layout, screenScale));
      return Object.freeze({
        id: layout.id,
        visualBounds,
        touchBounds: Object.freeze(expandAroundCenter(visualBounds, minimumTouchSize)),
        hitPriority,
      });
    }),
  );
}
