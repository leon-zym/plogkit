import type { LineMetrics, SkParagraph } from "@shopify/react-native-skia";

import type { SceneText } from "../scene";
import {
  createTextLayoutEnvironment,
  createTextLayoutSnapshot,
  createUnavailableTextLayoutEnvironment,
} from "../textLayout";

const TEXT: SceneText = {
  id: "text-1",
  content: "第一行\n第二行",
  x: 120,
  y: 240,
  width: 640,
  fontId: "system-sans",
  fontSize: 42,
  color: "#101010",
  alignment: "right",
  lineHeight: 1.4,
  backgroundColor: null,
};

function line(left: number, width: number, lineNumber: number): LineMetrics {
  return {
    startIndex: 0,
    endIndex: 2,
    endExcludingWhitespaces: 2,
    endIncludingNewline: 3,
    isHardBreak: lineNumber === 0,
    ascent: 30,
    descent: 10,
    height: 40,
    left,
    baseline: 40 + lineNumber * 50,
    lineNumber,
    width,
  };
}

function makeParagraph(metrics: readonly LineMetrics[], height: number): SkParagraph {
  return {
    dispose: jest.fn(),
    getHeight: jest.fn(() => height),
    getLineMetrics: jest.fn(() => [...metrics]),
    layout: jest.fn(),
    paint: jest.fn(),
  } as unknown as SkParagraph;
}

function makeEnvironment(paragraphs: readonly SkParagraph[]) {
  const queue = [...paragraphs];
  return createTextLayoutEnvironment({
    api: {
      Color: (color: string) => color as never,
      ParagraphBuilder: {
        Make: () => ({
          addText: () => undefined,
          build: () => queue.shift(),
          dispose: () => undefined,
          pop: () => undefined,
          pushStyle: () => undefined,
        }),
      },
    } as never,
    fontFamilies: { "system-sans": ["Test Sans"] },
    fontProvider: {} as never,
  });
}

describe("text layout snapshot", () => {
  it("derives visible width from real line metrics instead of the wrapping constraint", () => {
    const paragraph = makeParagraph([line(420, 220, 0), line(500, 140, 1)], 104);

    const result = createTextLayoutSnapshot(makeEnvironment([paragraph]), [TEXT]);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.snapshot.geometry).toEqual([
      {
        id: "text-1",
        placement: { x: 120, y: 240 },
        localVisualBounds: { x: 420, y: 0, width: 220, height: 104 },
      },
    ]);
    expect(result.snapshot.layouts[0]?.paragraph).toBe(paragraph);
  });

  it("unions vertical line metrics with Paragraph height for visual bounds", () => {
    const paragraph = makeParagraph(
      [
        { ...line(12, 100, 0), ascent: 30, baseline: 20, descent: 8 },
        { ...line(12, 100, 1), ascent: 30, baseline: 96, descent: 12 },
      ],
      100,
    );

    const result = createTextLayoutSnapshot(makeEnvironment([paragraph]), [TEXT]);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.snapshot.geometry[0]?.localVisualBounds).toEqual({
      x: 12,
      y: -10,
      width: 100,
      height: 118,
    });
  });

  it("returns a typed failure when the immutable environment is not ready", () => {
    const result = createTextLayoutSnapshot(
      createUnavailableTextLayoutEnvironment("bundled font registration failed"),
      [TEXT],
    );

    expect(result).toEqual({
      status: "failure",
      code: "environment-unavailable",
      message: "bundled font registration failed",
    });
  });

  it("releases a partially created snapshot and makes final disposal idempotent", () => {
    const first = makeParagraph([line(0, 80, 0)], 42);
    const broken = makeParagraph([line(0, 80, 0)], 42);
    jest.mocked(broken.getLineMetrics).mockImplementation(() => {
      throw new Error("metrics unavailable");
    });

    const failed = createTextLayoutSnapshot(makeEnvironment([first, broken]), [
      TEXT,
      { ...TEXT, id: "text-2" },
    ]);

    expect(failed).toMatchObject({
      status: "failure",
      code: "layout-failed",
      textId: "text-2",
    });
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(broken.dispose).toHaveBeenCalledTimes(1);

    const owned = makeParagraph([line(0, 80, 0)], 42);
    const ready = createTextLayoutSnapshot(makeEnvironment([owned]), [TEXT]);
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") return;

    ready.snapshot.dispose();
    ready.snapshot.dispose();

    expect(owned.dispose).toHaveBeenCalledTimes(1);
    expect(() => ready.snapshot.geometry).toThrow("text layout snapshot has been disposed");
  });

  it("releases a Paragraph when its own layout fails before snapshot ownership transfers", () => {
    const broken = makeParagraph([], 0);
    jest.mocked(broken.layout).mockImplementation(() => {
      throw new Error("layout failed");
    });

    const result = createTextLayoutSnapshot(makeEnvironment([broken]), [TEXT]);

    expect(result).toMatchObject({ status: "failure", code: "layout-failed" });
    expect(broken.dispose).toHaveBeenCalledTimes(1);
  });
});
