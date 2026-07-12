import type { SourceImage, StitchSettings } from "../document";
import { containRect, layoutStitch } from "../layout";

const images: readonly SourceImage[] = [
  {
    id: "wide",
    originalUri: "file:///wide.jpg",
    previewUri: "file:///wide-preview.jpg",
    width: 400,
    height: 200,
  },
  {
    id: "square",
    originalUri: "file:///square.jpg",
    previewUri: "file:///square-preview.jpg",
    width: 200,
    height: 200,
  },
  {
    id: "tall",
    originalUri: "file:///tall.jpg",
    previewUri: "file:///tall-preview.jpg",
    width: 100,
    height: 200,
  },
  {
    id: "wide-2",
    originalUri: "file:///wide-2.jpg",
    previewUri: "file:///wide-2-preview.jpg",
    width: 300,
    height: 100,
  },
];

const stitch = (
  mode: StitchSettings["mode"],
  order: readonly string[],
  spacing = 10,
): StitchSettings => ({ mode, order, spacing });

describe("contain geometry", () => {
  it("centers a wide source inside a square frame", () => {
    expect(
      containRect({ width: 400, height: 200 }, { x: 0, y: 0, width: 100, height: 100 }),
    ).toEqual({ x: 0, y: 25, width: 100, height: 50 });
  });

  it("centers a tall source inside a square frame", () => {
    expect(
      containRect({ width: 100, height: 200 }, { x: 0, y: 0, width: 100, height: 100 }),
    ).toEqual({ x: 25, y: 0, width: 50, height: 100 });
  });
});

describe("stitch layout", () => {
  it("lays out vertical images at a common width in document order", () => {
    const result = layoutStitch(images.slice(0, 2), stitch("vertical", ["square", "wide"]), 200);

    expect(result).toEqual({
      width: 200,
      height: 310,
      items: [
        {
          imageId: "square",
          frame: { x: 0, y: 0, width: 200, height: 200 },
          content: { x: 0, y: 0, width: 200, height: 200 },
        },
        {
          imageId: "wide",
          frame: { x: 0, y: 210, width: 200, height: 100 },
          content: { x: 0, y: 210, width: 200, height: 100 },
        },
      ],
    });
  });

  it("uses equal square cells for a two-column adaptive grid", () => {
    const result = layoutStitch(
      images,
      stitch(
        "grid",
        images.map(({ id }) => id),
      ),
      210,
    );

    expect(result.width).toBe(210);
    expect(result.height).toBe(210);
    expect(result.items.map(({ frame }) => frame)).toEqual([
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 110, y: 0, width: 100, height: 100 },
      { x: 0, y: 110, width: 100, height: 100 },
      { x: 110, y: 110, width: 100, height: 100 },
    ]);
    expect(result.items[0]?.content).toEqual({ x: 0, y: 25, width: 100, height: 50 });
  });

  it("leaves an odd final grid item in the leading column", () => {
    const three = images.slice(0, 3);
    const result = layoutStitch(
      three,
      stitch(
        "grid",
        three.map(({ id }) => id),
      ),
      210,
    );

    expect(result.height).toBe(210);
    expect(result.items[2]?.frame).toEqual({ x: 0, y: 110, width: 100, height: 100 });
  });

  it("uses one full-width cell for a single grid image", () => {
    const result = layoutStitch([images[0]], stitch("grid", ["wide"]), 210);

    expect(result.height).toBe(210);
    expect(result.items[0]?.frame).toEqual({ x: 0, y: 0, width: 210, height: 210 });
  });

  it("returns an empty zero-height canvas when there are no images", () => {
    expect(layoutStitch([], stitch("vertical", []), 200)).toEqual({
      width: 200,
      height: 0,
      items: [],
    });
  });

  it("rejects invalid dimensions, image counts, and order", () => {
    expect(() =>
      layoutStitch(
        images,
        stitch(
          "vertical",
          images.map(({ id }) => id),
        ),
        0,
      ),
    ).toThrow("canvas width");
    expect(() => containRect({ width: 0, height: 1 }, { x: 0, y: 0, width: 1, height: 1 })).toThrow(
      "positive",
    );
    expect(() =>
      containRect({ width: 1, height: 1 }, { x: Number.NaN, y: 0, width: 1, height: 1 }),
    ).toThrow("finite");
    expect(() =>
      layoutStitch(
        Array.from({ length: 10 }, (_, index) => ({ ...images[0], id: `image-${index}` })),
        stitch(
          "vertical",
          Array.from({ length: 10 }, (_, index) => `image-${index}`),
        ),
        200,
      ),
    ).toThrow("at most 9");
    expect(() => layoutStitch(images, stitch("vertical", ["wide"]), 200)).toThrow(
      "exact permutation",
    );
    expect(() =>
      layoutStitch(
        images,
        stitch(
          "vertical",
          images.map(({ id }) => id),
          -1,
        ),
        200,
      ),
    ).toThrow("spacing");
    expect(() =>
      layoutStitch(
        images,
        stitch(
          "grid",
          images.map(({ id }) => id),
          300,
        ),
        200,
      ),
    ).toThrow("no room");
  });
});
