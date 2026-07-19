import {
  type FilterMode,
  type MipmapMode,
  type SkCanvas,
  type SkImage,
} from "@shopify/react-native-skia";

import type { RenderScene, SceneImage } from "./scene";
import type { TextLayout } from "./textLayout";

type SkiaApi = typeof import("@shopify/react-native-skia").Skia;

const FILTER_LINEAR = 1 as FilterMode;
const MIPMAP_NONE = 0 as MipmapMode;

export function drawSceneBackground(api: SkiaApi, canvas: SkCanvas, scene: RenderScene): void {
  const paint = api.Paint();
  try {
    paint.setColor(api.Color(scene.backgroundColor));
    canvas.drawRect(api.XYWHRect(0, 0, scene.width, scene.height), paint);
  } finally {
    paint.dispose();
  }
}

export function drawSceneImage(
  api: SkiaApi,
  canvas: SkCanvas,
  node: SceneImage,
  image: SkImage,
): void {
  const paint = api.Paint();
  try {
    paint.setAntiAlias(true);
    canvas.drawImageRectOptions(
      image,
      api.XYWHRect(0, 0, image.width(), image.height()),
      api.XYWHRect(
        node.destination.x,
        node.destination.y,
        node.destination.width,
        node.destination.height,
      ),
      FILTER_LINEAR,
      MIPMAP_NONE,
      paint,
    );
  } finally {
    paint.dispose();
  }
}

/** Paints an already laid-out Paragraph borrowed from its owning snapshot. */
export function drawTextLayout(canvas: SkCanvas, layout: TextLayout): void {
  layout.paragraph.paint(canvas, layout.placement.x, layout.placement.y);
}
