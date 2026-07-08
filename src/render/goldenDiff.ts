export interface RgbaDiff {
  readonly matches: boolean;
  readonly changedPixels: number;
  readonly totalPixels: number;
  readonly rgba: Uint8Array;
}

/** Dependency-free pixel diff used by the CanvasKit golden harness. */
export function diffRgba(
  actual: Uint8Array,
  expected: Uint8Array,
  width: number,
  height: number,
  threshold = 0,
): RgbaDiff {
  const expectedLength = width * height * 4;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("golden dimensions must be positive integers");
  }
  if (actual.length !== expectedLength || expected.length !== expectedLength) {
    throw new Error("RGBA buffer length does not match golden dimensions");
  }
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) {
    throw new Error("golden threshold must be an integer from 0 to 255");
  }

  const rgba = new Uint8Array(expectedLength);
  let changedPixels = 0;
  for (let offset = 0; offset < expectedLength; offset += 4) {
    const difference = Math.max(
      Math.abs(actual[offset]! - expected[offset]!),
      Math.abs(actual[offset + 1]! - expected[offset + 1]!),
      Math.abs(actual[offset + 2]! - expected[offset + 2]!),
      Math.abs(actual[offset + 3]! - expected[offset + 3]!),
    );
    if (difference > threshold) {
      changedPixels += 1;
      rgba[offset] = 255;
      rgba[offset + 1] = 0;
      rgba[offset + 2] = 80;
      rgba[offset + 3] = 255;
    } else {
      const luminance = Math.round(
        actual[offset]! * 0.2126 + actual[offset + 1]! * 0.7152 + actual[offset + 2]! * 0.0722,
      );
      rgba[offset] = luminance;
      rgba[offset + 1] = luminance;
      rgba[offset + 2] = luminance;
      rgba[offset + 3] = 80;
    }
  }

  return {
    matches: changedPixels === 0,
    changedPixels,
    totalPixels: width * height,
    rgba,
  };
}
