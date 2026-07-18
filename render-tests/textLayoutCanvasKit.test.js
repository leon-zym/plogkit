import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LoadSkiaWeb } from "@shopify/react-native-skia/lib/commonjs/web/LoadSkiaWeb";

import {
  createHeadlessFontProvider,
  createHeadlessTextLayoutEnvironment,
} from "../src/render/headless";
import { createTextLayoutSnapshot } from "../src/render/textLayout";

const FONT_DIR = join(__dirname, "fonts");

const text = (id, content, overrides = {}) => ({
  id,
  content,
  x: 20,
  y: 30,
  width: 200,
  fontId: "system-sans",
  fontSize: 24,
  color: "#101010",
  alignment: "left",
  lineHeight: 1.2,
  backgroundColor: null,
  ...overrides,
});

describe("real CanvasKit text layout snapshot", () => {
  let fontProvider;
  let environment;

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
    environment = createHeadlessTextLayoutEnvironment(fontProvider, {
      "system-sans": ["Test Latin", "Test CJK"],
      "system-serif": ["Test Latin", "Test CJK"],
    });
  });

  afterAll(() => {
    fontProvider.dispose();
  });

  function withSnapshot(texts, assertSnapshot) {
    const result = createTextLayoutSnapshot(environment, texts);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    try {
      assertSnapshot(result.snapshot);
    } finally {
      result.snapshot.dispose();
    }
  }

  it("lays out CJK fallback, automatic wrapping, and explicit hard breaks", () => {
    withSnapshot(
      [
        text("fallback", "AB周末"),
        text("wrapped", "周末的海边日记", { width: 54 }),
        text("single", "第一行第二行"),
        text("hard-break", "第一行\n第二行"),
      ],
      (snapshot) => {
        const [fallback, wrapped, single, hardBreak] = snapshot.geometry;
        expect(fallback.localVisualBounds).toMatchObject({ x: 0 });
        expect(fallback.localVisualBounds.width).toBeGreaterThan(0);
        expect(wrapped.localVisualBounds.width).toBeLessThanOrEqual(54);
        expect(wrapped.localVisualBounds.height).toBeGreaterThan(fallback.localVisualBounds.height);
        expect(hardBreak.localVisualBounds.height).toBeGreaterThan(single.localVisualBounds.height);
      },
    );
  });

  it("uses the CJK fallback glyphs rather than Latin .notdef geometry", () => {
    const latinOnlyProvider = createHeadlessFontProvider([
      {
        family: "Test Latin",
        bytes: Uint8Array.from(readFileSync(join(FONT_DIR, "NotoSans-TestSubset.ttf"))),
      },
    ]);
    const latinOnlyEnvironment = createHeadlessTextLayoutEnvironment(latinOnlyProvider, {
      "system-sans": ["Test Latin"],
    });
    let fallbackSnapshot = null;
    let notdefSnapshot = null;

    try {
      const fallbackResult = createTextLayoutSnapshot(environment, [text("fallback", "周末")]);
      const notdefResult = createTextLayoutSnapshot(latinOnlyEnvironment, [
        text("notdef", "周末"),
      ]);
      expect(fallbackResult.status).toBe("ready");
      expect(notdefResult.status).toBe("ready");
      if (fallbackResult.status !== "ready" || notdefResult.status !== "ready") return;
      fallbackSnapshot = fallbackResult.snapshot;
      notdefSnapshot = notdefResult.snapshot;

      const fallbackWidth = fallbackSnapshot.geometry[0].localVisualBounds.width;
      const notdefWidth = notdefSnapshot.geometry[0].localVisualBounds.width;
      expect(fallbackWidth).toBeGreaterThan(notdefWidth);
      expect(fallbackWidth - notdefWidth).toBeGreaterThan(1);
    } finally {
      fallbackSnapshot?.dispose();
      notdefSnapshot?.dispose();
      latinOnlyProvider.dispose();
    }
  });

  it("derives horizontal bounds from left, center, and right aligned line metrics", () => {
    withSnapshot(
      [
        text("left", "AB", { alignment: "left" }),
        text("center", "AB", { alignment: "center" }),
        text("right", "AB", { alignment: "right" }),
      ],
      (snapshot) => {
        const [left, center, right] = snapshot.geometry.map(
          ({ localVisualBounds }) => localVisualBounds,
        );
        expect(left.x).toBeCloseTo(0);
        expect(center.x).toBeGreaterThan(left.x);
        expect(right.x).toBeGreaterThan(center.x);
        expect(center.width).toBeCloseTo(left.width);
        expect(right.width).toBeCloseTo(left.width);
      },
    );
  });

  it("uses Paragraph line height and keeps missing emoji fallback geometry finite", () => {
    withSnapshot(
      [
        text("compact", "第一行\n第二行", { lineHeight: 1 }),
        text("spacious", "第一行\n第二行", { lineHeight: 1.8 }),
        text("emoji", "周末🙂"),
      ],
      (snapshot) => {
        const [compact, spacious, emoji] = snapshot.geometry.map(
          ({ localVisualBounds }) => localVisualBounds,
        );
        expect(spacious.height).toBeGreaterThan(compact.height);
        expect(emoji.width).toBeGreaterThan(0);
        expect(Number.isFinite(emoji.height)).toBe(true);
        expect(emoji.height).toBeGreaterThan(0);
      },
    );
  });
});
