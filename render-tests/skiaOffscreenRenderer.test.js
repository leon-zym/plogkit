import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LoadSkiaWeb } from "@shopify/react-native-skia/lib/commonjs/web/LoadSkiaWeb";
import {
  AlphaType,
  ColorType,
  getSkiaExports,
} from "@shopify/react-native-skia/lib/commonjs/headless";

import {
  createHeadlessFontProvider,
  createHeadlessTextLayoutEnvironment,
} from "../src/render/headless";
import { createHeadlessSkiaOffscreenSceneRenderer } from "../src/render/headlessSkiaOffscreenRenderer";

const ONE_PIXEL_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const FONT_DIR = join(__dirname, "fonts");

function decode(bytes) {
  const { Skia } = getSkiaExports();
  const data = Skia.Data.fromBytes(bytes);
  try {
    const image = Skia.Image.MakeImageFromEncoded(data);
    if (image === null) throw new Error("renderer output could not decode");
    return image;
  } finally {
    data.dispose();
  }
}

function readRgba(image) {
  const pixels = image.readPixels(0, 0, {
    width: image.width(),
    height: image.height(),
    alphaType: AlphaType.Unpremul,
    colorType: ColorType.RGBA_8888,
  });
  if (!(pixels instanceof Uint8Array)) throw new Error("could not read renderer output");
  return pixels;
}

function pixelAt(rgba, width, x, y) {
  const offset = (y * width + x) * 4;
  return [...rgba.slice(offset, offset + 4)];
}

describe("shared Skia offscreen renderer with real CanvasKit", () => {
  let fontProvider;
  let textLayoutEnvironment;

  beforeAll(async () => {
    await LoadSkiaWeb();
    fontProvider = createHeadlessFontProvider([
      {
        family: "Test Latin",
        bytes: Uint8Array.from(readFileSync(join(FONT_DIR, "NotoSans-TestSubset.ttf"))),
      },
    ]);
    textLayoutEnvironment = createHeadlessTextLayoutEnvironment(fontProvider, {
      "system-sans": ["Test Latin"],
    });
  });

  afterAll(() => {
    fontProvider.dispose();
  });

  it("renders square crop and original targets from one complete background/image/text scene", async () => {
    const scene = {
      width: 100,
      height: 200,
      backgroundColor: "#C43D52",
      images: [
        {
          imageId: "top",
          sourceSize: { width: 1, height: 1 },
          destination: { x: 0, y: 0, width: 100, height: 80 },
        },
        {
          imageId: "bottom",
          sourceSize: { width: 1, height: 1 },
          destination: { x: 0, y: 120, width: 100, height: 80 },
        },
      ],
      texts: [
        {
          id: "caption",
          content: "A",
          x: 10,
          y: 20,
          width: 40,
          fontId: "system-sans",
          fontSize: 24,
          color: "#101010",
          alignment: "left",
          lineHeight: 1.2,
          backgroundColor: null,
        },
      ],
    };
    const renderer = createHeadlessSkiaOffscreenSceneRenderer(
      new Map([
        ["fixture://top", ONE_PIXEL_PNG],
        ["fixture://bottom", ONE_PIXEL_PNG],
      ]),
      textLayoutEnvironment,
    );

    const result = await renderer.render({
      scene,
      assets: {
        resolve: (imageId) => ({ uri: `fixture://${imageId}` }),
      },
      targets: [
        {
          id: "square",
          width: 100,
          height: 100,
          transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: -50 },
          encoding: { format: "png" },
        },
        {
          id: "original",
          width: 100,
          height: 200,
          transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 },
          encoding: { format: "png" },
        },
      ],
    });

    expect(result.status).toBe("rendered");
    if (result.status !== "rendered") return;
    const square = decode(result.outputs.square.bytes);
    const original = decode(result.outputs.original.bytes);
    try {
      expect([square.width(), square.height()]).toEqual([100, 100]);
      expect([original.width(), original.height()]).toEqual([100, 200]);
      const squareRgba = readRgba(square);
      const originalRgba = readRgba(original);
      const compositedImageColor = pixelAt(originalRgba, 100, 90, 10);
      expect(compositedImageColor).not.toEqual([196, 61, 82, 255]);
      expect(pixelAt(squareRgba, 100, 90, 10)).toEqual(compositedImageColor);
      expect(pixelAt(squareRgba, 100, 90, 50)).toEqual([196, 61, 82, 255]);
      expect(pixelAt(squareRgba, 100, 90, 90)).toEqual(compositedImageColor);
      expect(pixelAt(originalRgba, 100, 90, 100)).toEqual([196, 61, 82, 255]);
      expect(pixelAt(originalRgba, 100, 90, 190)).toEqual(compositedImageColor);

      const textRegion = [];
      for (let y = 20; y < 50; y += 1) {
        for (let x = 10; x < 40; x += 1) {
          textRegion.push(pixelAt(originalRgba, 100, x, y));
        }
      }
      expect(
        textRegion.some(
          ([red, green, blue, alpha]) => alpha === 255 && red < 100 && green < 100 && blue < 100,
        ),
      ).toBe(true);
    } finally {
      square.dispose();
      original.dispose();
    }
  });
});
