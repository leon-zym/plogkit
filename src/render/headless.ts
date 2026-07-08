import {
  getSkiaExports,
  makeOffscreenSurface,
  AlphaType,
  ColorType,
  ImageFormat,
  type SkImage,
  type SkTypefaceFontProvider,
} from "@shopify/react-native-skia/lib/commonjs/headless";

import { diffRgba, type RgbaDiff } from "./goldenDiff";
import type { RenderScene } from "./scene";
import {
  drawSceneBackground,
  drawSceneImage,
  drawSceneText,
  type FontFamilyResolver,
} from "./skiaDraw";

export interface HeadlessFont {
  readonly family: string;
  readonly bytes: Uint8Array;
}

export interface HeadlessRenderOptions {
  readonly width?: number;
  readonly height?: number;
  readonly fontProvider?: SkTypefaceFontProvider;
  readonly resolveFontFamilies?: FontFamilyResolver;
}

export interface GoldenComparison extends Omit<RgbaDiff, "rgba"> {
  readonly diffPng: Uint8Array;
}

/** Registers bundled font bytes so CanvasKit text goldens never depend on host fonts. */
export function createHeadlessFontProvider(fonts: readonly HeadlessFont[]): SkTypefaceFontProvider {
  const { Skia } = getSkiaExports();
  const provider = Skia.TypefaceFontProvider.Make();
  try {
    for (const font of fonts) {
      const data = Skia.Data.fromBytes(font.bytes);
      let typeface = null;
      try {
        typeface = Skia.Typeface.MakeFreeTypeFaceFromData(data);
      } finally {
        data.dispose();
      }
      if (typeface === null) {
        throw new Error(`could not decode golden font ${font.family}`);
      }
      try {
        provider.registerFont(typeface, font.family);
      } finally {
        typeface.dispose();
      }
    }
    return provider;
  } catch (error: unknown) {
    provider.dispose();
    throw error;
  }
}

/** CanvasKit harness: encoded image fixtures + shared scene -> deterministic PNG bytes. */
export async function renderHeadlessScene(
  scene: RenderScene,
  encodedImages: ReadonlyMap<string, Uint8Array>,
  options: HeadlessRenderOptions = {},
): Promise<Uint8Array> {
  const { Skia } = getSkiaExports();
  const width = options.width ?? Math.round(scene.width);
  const height = options.height ?? Math.round(scene.height);
  const surface = makeOffscreenSurface(width, height);
  const images = new Map<string, SkImage>();
  let snapshot: SkImage | null = null;

  try {
    for (const node of scene.images) {
      const encoded = encodedImages.get(node.imageId);
      if (encoded === undefined) {
        throw new Error(`headless fixture is missing image ${node.imageId}`);
      }
      const data = Skia.Data.fromBytes(encoded);
      let image: SkImage | null = null;
      try {
        image = Skia.Image.MakeImageFromEncoded(data);
      } finally {
        data.dispose();
      }
      if (image === null) {
        throw new Error(`could not decode headless image ${node.imageId}`);
      }
      images.set(node.imageId, image);
    }

    if (scene.texts.length > 0 && options.fontProvider === undefined) {
      throw new Error("headless text rendering requires a bundled-font provider");
    }

    const sceneSkia = Skia as unknown as typeof import("@shopify/react-native-skia").Skia;
    const canvas = surface.getCanvas();
    canvas.scale(width / scene.width, height / scene.height);
    drawSceneBackground(sceneSkia, canvas, scene);
    for (const node of scene.images) {
      const image = images.get(node.imageId);
      if (image === undefined) {
        throw new Error(`headless image ${node.imageId} was not loaded`);
      }
      drawSceneImage(sceneSkia, canvas, node, image);
    }
    for (const text of scene.texts) {
      drawSceneText(
        sceneSkia,
        canvas,
        text,
        options.fontProvider,
        options.resolveFontFamilies,
      );
    }
    surface.flush();
    snapshot = surface.makeImageSnapshot();
    return snapshot.encodeToBytes(ImageFormat.PNG, 100);
  } finally {
    snapshot?.dispose();
    for (const image of images.values()) {
      image.dispose();
    }
    surface.dispose();
  }
}

function decodePng(png: Uint8Array, label: string): SkImage {
  const { Skia } = getSkiaExports();
  const data = Skia.Data.fromBytes(png);
  try {
    const image = Skia.Image.MakeImageFromEncoded(data);
    if (image === null) {
      throw new Error(`could not decode ${label} PNG`);
    }
    return image;
  } finally {
    data.dispose();
  }
}

function readRgba(image: SkImage): Uint8Array {
  const pixels = image.readPixels(0, 0, {
    width: image.width(),
    height: image.height(),
    alphaType: AlphaType.Unpremul,
    colorType: ColorType.RGBA_8888,
  });
  if (!(pixels instanceof Uint8Array)) {
    throw new Error("CanvasKit could not read golden pixels as RGBA8888");
  }
  return pixels;
}

function encodeRgbaPng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const { Skia } = getSkiaExports();
  const data = Skia.Data.fromBytes(rgba);
  let image: SkImage | null = null;
  try {
    image = Skia.Image.MakeImage(
      { width, height, alphaType: AlphaType.Unpremul, colorType: ColorType.RGBA_8888 },
      data,
      width * 4,
    );
    if (image === null) {
      throw new Error("CanvasKit could not create the golden diff image");
    }
    return image.encodeToBytes(ImageFormat.PNG, 100);
  } finally {
    image?.dispose();
    data.dispose();
  }
}

/** Compares reviewable PNG goldens and returns a magenta-on-gray PNG diff. */
export function compareGoldenPng(
  actualPng: Uint8Array,
  expectedPng: Uint8Array,
  threshold = 0,
): GoldenComparison {
  const actual = decodePng(actualPng, "actual");
  const expected = decodePng(expectedPng, "expected");
  try {
    if (actual.width() !== expected.width() || actual.height() !== expected.height()) {
      throw new Error("golden PNG dimensions do not match");
    }
    const diff = diffRgba(
      readRgba(actual),
      readRgba(expected),
      actual.width(),
      actual.height(),
      threshold,
    );
    return {
      matches: diff.matches,
      changedPixels: diff.changedPixels,
      totalPixels: diff.totalPixels,
      diffPng: encodeRgbaPng(diff.rgba, actual.width(), actual.height()),
    };
  } finally {
    actual.dispose();
    expected.dispose();
  }
}
