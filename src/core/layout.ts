import {
  isExactImageOrder,
  MAX_SOURCE_IMAGES,
  type ImportedAssetId,
  type SourceImage,
  type StitchSettings,
} from "./document";

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect extends Size {
  readonly x: number;
  readonly y: number;
}

export interface LayoutItem {
  readonly imageId: ImportedAssetId;
  readonly frame: Rect;
  readonly content: Rect;
}

export interface StitchLayout {
  readonly width: number;
  readonly height: number;
  readonly items: readonly LayoutItem[];
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite`);
  }
}

function requirePositiveFinite(value: number, name: string): void {
  requireFinite(value, name);
  if (value <= 0) {
    throw new Error(`${name} must be positive and finite`);
  }
}

export function containRect(source: Size, bounds: Rect): Rect {
  requirePositiveFinite(source.width, "source width");
  requirePositiveFinite(source.height, "source height");
  requireFinite(bounds.x, "bounds x");
  requireFinite(bounds.y, "bounds y");
  requirePositiveFinite(bounds.width, "bounds width");
  requirePositiveFinite(bounds.height, "bounds height");

  const scale = Math.min(bounds.width / source.width, bounds.height / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  return {
    x: bounds.x + (bounds.width - width) / 2,
    y: bounds.y + (bounds.height - height) / 2,
    width,
    height,
  };
}

function resolveImages(
  images: readonly SourceImage[],
  order: readonly ImportedAssetId[],
): readonly SourceImage[] {
  if (images.length > MAX_SOURCE_IMAGES) {
    throw new Error(`stitch layout supports at most ${MAX_SOURCE_IMAGES} images`);
  }
  const imageIds = images.map(({ id }) => id);
  if (new Set(imageIds).size !== imageIds.length || !isExactImageOrder(order, imageIds)) {
    throw new Error("image order must be an exact permutation of source image ids");
  }
  const byId = new Map(images.map((image) => [image.id, image]));
  return order.map((id) => {
    const image = byId.get(id);
    if (image === undefined) {
      throw new Error(`source image ${id} does not exist`);
    }
    requirePositiveFinite(image.width, `source image ${id} width`);
    requirePositiveFinite(image.height, `source image ${id} height`);
    return image;
  });
}

function layoutVertical(
  images: readonly SourceImage[],
  width: number,
  spacing: number,
): StitchLayout {
  let y = 0;
  const items = images.map((image, index): LayoutItem => {
    const height = (width * image.height) / image.width;
    const frame = { x: 0, y, width, height };
    y += height;
    if (index < images.length - 1) {
      y += spacing;
    }
    return { imageId: image.id, frame, content: frame };
  });
  return { width, height: y, items };
}

function layoutGrid(images: readonly SourceImage[], width: number, spacing: number): StitchLayout {
  const columns = images.length <= 1 ? 1 : 2;
  const cellSize = (width - spacing * (columns - 1)) / columns;
  if (cellSize <= 0) {
    throw new Error("stitch spacing leaves no room for grid cells");
  }
  const items = images.map((image, index): LayoutItem => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const frame = {
      x: column * (cellSize + spacing),
      y: row * (cellSize + spacing),
      width: cellSize,
      height: cellSize,
    };
    return {
      imageId: image.id,
      frame,
      content: containRect(image, frame),
    };
  });
  const rows = images.length === 0 ? 0 : Math.ceil(images.length / columns);
  const height = rows === 0 ? 0 : rows * cellSize + (rows - 1) * spacing;
  return { width, height, items };
}

export function layoutStitch(
  images: readonly SourceImage[],
  stitch: StitchSettings,
  canvasWidth: number,
): StitchLayout {
  requirePositiveFinite(canvasWidth, "canvas width");
  if (!Number.isFinite(stitch.spacing) || stitch.spacing < 0) {
    throw new Error("stitch spacing must be a non-negative finite number");
  }
  const orderedImages = resolveImages(images, stitch.order);
  return stitch.mode === "vertical"
    ? layoutVertical(orderedImages, canvasWidth, stitch.spacing)
    : layoutGrid(orderedImages, canvasWidth, stitch.spacing);
}
