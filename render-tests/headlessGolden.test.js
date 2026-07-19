import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LoadSkiaWeb } from "@shopify/react-native-skia/lib/commonjs/web/LoadSkiaWeb";

import {
  compareGoldenPng,
  createHeadlessFontProvider,
  createHeadlessTextLayoutEnvironment,
  renderHeadlessScene,
} from "../src/render/headless";

const ONE_PIXEL_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const GOLDEN_PATH = join(__dirname, "goldens", "basic-scene.png");
const DIFF_PATH = "/tmp/plogkit-basic-scene-diff.png";
const ACTUAL_PATH = "/tmp/plogkit-basic-scene-actual.png";
const FONT_DIR = join(__dirname, "fonts");

/** @type {import("../src/render/scene").RenderScene} */
const scene = {
  width: 96,
  height: 128,
  backgroundColor: "#F6F1E8",
  images: [
    {
      imageId: "pixel",
      uri: "fixture://pixel.png",
      sourceSize: { width: 1, height: 1 },
      destination: { x: 16, y: 20, width: 64, height: 80 },
    },
  ],
  texts: [
    {
      id: "caption",
      content: "AB\n周末",
      x: 18,
      y: 24,
      width: 60,
      fontId: "system-sans",
      fontSize: 11,
      color: "#FFFFFF",
      alignment: "right",
      lineHeight: 1.15,
      backgroundColor: "#101010CC",
    },
  ],
};

describe("headless render golden", () => {
  let fontProvider;
  let textLayoutEnvironment;

  beforeAll(async () => {
    await LoadSkiaWeb();
    fontProvider = createHeadlessFontProvider([
      {
        family: "Test Latin",
        bytes: Uint8Array.from(readFileSync(join(FONT_DIR, "NotoSans-TestSubset.ttf"))),
      },
      {
        family: "Test CJK",
        bytes: Uint8Array.from(readFileSync(join(FONT_DIR, "NotoSansSC-TestSubset.ttf"))),
      },
    ]);
    textLayoutEnvironment = createHeadlessTextLayoutEnvironment(fontProvider, {
      "system-sans": ["Test Latin", "Test CJK"],
    });
  });

  afterAll(() => {
    fontProvider.dispose();
  });

  it("renders the shared scene deterministically", async () => {
    const actual = await renderHeadlessScene(scene, new Map([["pixel", ONE_PIXEL_PNG]]), {
      textLayoutEnvironment,
    });
    if (process.env.UPDATE_GOLDENS === "1") {
      writeFileSync(GOLDEN_PATH, actual);
    }
    const expected = Uint8Array.from(readFileSync(GOLDEN_PATH));
    const comparison = compareGoldenPng(actual, expected);
    if (!comparison.matches) {
      writeFileSync(ACTUAL_PATH, actual);
      writeFileSync(DIFF_PATH, comparison.diffPng);
    }

    expect(comparison.changedPixels).toBe(0);
  });
});
