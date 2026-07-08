import { diffRgba } from "../goldenDiff";

describe("reviewable golden diff", () => {
  it("marks changed pixels in magenta and unchanged pixels in translucent gray", () => {
    const expected = new Uint8Array([10, 20, 30, 255, 100, 100, 100, 255]);
    const actual = new Uint8Array([10, 20, 30, 255, 110, 100, 100, 255]);

    const result = diffRgba(actual, expected, 2, 1);

    expect(result).toMatchObject({ matches: false, changedPixels: 1, totalPixels: 2 });
    expect([...result.rgba.slice(4)]).toEqual([255, 0, 80, 255]);
    expect(result.rgba[3]).toBe(80);
  });

  it("supports a small per-channel tolerance", () => {
    const expected = new Uint8Array([10, 20, 30, 255]);
    const actual = new Uint8Array([12, 19, 30, 255]);

    expect(diffRgba(actual, expected, 1, 1, 2).matches).toBe(true);
  });
});
