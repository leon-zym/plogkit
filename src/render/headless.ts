import {
  getSkiaExports,
  AlphaType,
  ColorType,
  ImageFormat,
  type SkImage,
  type SkTypefaceFontProvider,
} from "@shopify/react-native-skia/lib/commonjs/headless";

import { diffRgba, type RgbaDiff } from "./goldenDiff";
import { createHeadlessSkiaOffscreenSceneRenderer } from "./headlessSkiaOffscreenRenderer";
import type { RenderScene } from "./scene";
import {
  createTextLayoutEnvironment,
  type AnyTextLayoutEnvironment,
  type TextLayoutEnvironment,
} from "./textLayout";

export interface HeadlessFont {
  readonly family: string;
  readonly bytes: Uint8Array;
}

export interface HeadlessRenderOptions {
  readonly width?: number;
  readonly height?: number;
  readonly textLayoutEnvironment?: AnyTextLayoutEnvironment;
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

export function createHeadlessTextLayoutEnvironment(
  fontProvider: SkTypefaceFontProvider,
  fontFamilies: Readonly<Record<string, readonly string[]>>,
): TextLayoutEnvironment {
  const { Skia } = getSkiaExports();
  return createTextLayoutEnvironment({
    api: Skia as unknown as typeof import("@shopify/react-native-skia").Skia,
    fontProvider,
    fontFamilies,
  });
}

/** CanvasKit harness: encoded image fixtures + shared scene -> deterministic PNG bytes. */
export async function renderHeadlessScene(
  scene: RenderScene,
  encodedImages: ReadonlyMap<string, Uint8Array>,
  options: HeadlessRenderOptions = {},
): Promise<Uint8Array> {
  const width = options.width ?? Math.round(scene.width);
  const height = options.height ?? Math.round(scene.height);
  const renderer = createHeadlessSkiaOffscreenSceneRenderer(
    encodedImages,
    options.textLayoutEnvironment,
  );
  const result = await renderer.render({
    scene,
    assets: {
      resolve: (imageId) => ({ uri: imageId }),
    },
    targets: [
      {
        id: "headless",
        width,
        height,
        transform: {
          scaleX: width / scene.width,
          scaleY: height / scene.height,
          translateX: 0,
          translateY: 0,
        },
        encoding: { format: "png" },
      },
    ],
  });
  if (result.status !== "rendered") {
    const detail =
      result.status === "cancelled"
        ? `cancelled during ${result.phase}`
        : `${result.code}: ${result.message}`;
    throw new Error(`headless scene rendering failed: ${detail}`);
  }
  const output = result.outputs.headless;
  if (output === undefined) throw new Error("headless renderer omitted its requested output");
  return output.bytes;
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
