import type {
  CanvasRatio,
  ImportedAssetId,
  PlogDocument,
  TextAlignment,
} from "../core/document";
import { containRect, layoutStitch, type Rect, type Size } from "../core/layout";

export const LOGICAL_CANVAS_WIDTH = 1000;

export type SceneImageUsage = "preview" | "original";

export interface SceneImageAssetResolver {
  readonly resolve: (
    assetId: ImportedAssetId,
    usage: SceneImageUsage,
  ) => { readonly uri: string } | null;
}

export interface SceneImage {
  readonly imageId: ImportedAssetId;
  readonly sourceSize: Size;
  readonly destination: Rect;
}

export interface SceneText {
  readonly id: string;
  readonly content: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly fontId: string;
  readonly fontSize: number;
  readonly color: string;
  readonly alignment: TextAlignment;
  readonly lineHeight: number;
  readonly backgroundColor: string | null;
}

export interface RenderScene extends Size {
  readonly backgroundColor: string;
  readonly images: readonly SceneImage[];
  readonly texts: readonly SceneText[];
}

const FIXED_RATIO_HEIGHTS: Readonly<Record<Exclude<CanvasRatio, "original">, number>> = {
  "1:1": LOGICAL_CANVAS_WIDTH,
  "3:4": (LOGICAL_CANVAS_WIDTH * 4) / 3,
  "4:5": (LOGICAL_CANVAS_WIDTH * 5) / 4,
  "9:16": (LOGICAL_CANVAS_WIDTH * 16) / 9,
};

function canvasHeight(ratio: CanvasRatio, contentHeight: number): number {
  if (ratio === "original") {
    return contentHeight > 0 ? contentHeight : LOGICAL_CANVAS_WIDTH;
  }
  return FIXED_RATIO_HEIGHTS[ratio];
}

function transformRect(rect: Rect, scale: number, offsetX: number, offsetY: number): Rect {
  return {
    x: offsetX + rect.x * scale,
    y: offsetY + rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/** Converts the serializable document into the shared, platform-free render scene. */
export function documentToRenderScene(
  document: PlogDocument,
): RenderScene {
  const layout = layoutStitch(document.sourceImages, document.stitch, LOGICAL_CANVAS_WIDTH);
  const height = canvasHeight(document.canvas.ratio, layout.height);
  const contentBounds =
    layout.height === 0
      ? { x: 0, y: 0, width: LOGICAL_CANVAS_WIDTH, height: 0 }
      : containRect(layout, { x: 0, y: 0, width: LOGICAL_CANVAS_WIDTH, height });
  const contentScale = contentBounds.width / LOGICAL_CANVAS_WIDTH;
  const sourceById = new Map(document.sourceImages.map((image) => [image.id, image]));

  const images = layout.items.map((item): SceneImage => {
    const source = sourceById.get(item.imageId);
    if (source === undefined) {
      throw new Error(`source image ${item.imageId} does not exist`);
    }
    return {
      imageId: item.imageId,
      sourceSize: { width: source.width, height: source.height },
      destination: transformRect(item.content, contentScale, contentBounds.x, contentBounds.y),
    };
  });

  return {
    width: LOGICAL_CANVAS_WIDTH,
    height,
    backgroundColor: document.canvas.backgroundColor,
    images,
    texts: document.textElements.map((text): SceneText => ({
      id: text.id,
      content: text.content,
      x: text.position.x,
      y: text.position.y,
      width: text.width,
      fontId: text.fontId,
      fontSize: text.fontSize,
      color: text.color,
      alignment: text.alignment,
      lineHeight: text.lineHeight,
      backgroundColor: text.backgroundColor,
    })),
  };
}

export function resolveSceneImageUri(
  assets: SceneImageAssetResolver,
  image: SceneImage,
  usage: SceneImageUsage,
): string {
  const descriptor = assets.resolve(image.imageId, usage);
  if (descriptor === null) {
    throw new Error(`${usage} asset ${image.imageId} is not available in this Draft`);
  }
  return descriptor.uri;
}

/** Resolves the source-driven size used before applying a data-driven export preset. */
export function getNaturalSceneSize(scene: RenderScene): Size {
  if (scene.images.length === 0) {
    return { width: scene.width, height: scene.height };
  }

  const scale = Math.max(
    ...scene.images.map(({ sourceSize, destination }) =>
      Math.max(sourceSize.width / destination.width, sourceSize.height / destination.height),
    ),
  );
  return {
    width: Math.max(1, Math.round(scene.width * scale)),
    height: Math.max(1, Math.round(scene.height * scale)),
  };
}
