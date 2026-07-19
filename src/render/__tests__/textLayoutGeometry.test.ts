import { projectTextLayoutGeometry, type TextLayoutGeometry } from "../textLayoutGeometry";

const geometry = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): TextLayoutGeometry => ({
  id,
  placement: { x, y },
  localVisualBounds: { x: 4, y: 6, width, height },
});

describe("text layout geometry projection", () => {
  it("keeps the selection box on visual bounds while expanding only touch bounds to 44pt", () => {
    const [projected] = projectTextLayoutGeometry([geometry("caption", 100, 200, 20, 10)], 0.5);

    expect(projected).toEqual({
      id: "caption",
      visualBounds: { x: 52, y: 103, width: 10, height: 5 },
      touchBounds: { x: 35, y: 83.5, width: 44, height: 44 },
      hitPriority: 0,
    });
  });

  it("maps logical placement and actual visual bounds using the current screen scale", () => {
    const [projected] = projectTextLayoutGeometry([geometry("headline", 12, 24, 160, 48)], 1.25);

    expect(projected?.visualBounds).toEqual({ x: 20, y: 37.5, width: 200, height: 60 });
    expect(projected?.touchBounds).toEqual(projected?.visualBounds);
  });
});
