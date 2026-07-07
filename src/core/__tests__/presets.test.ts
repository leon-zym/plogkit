import {
  calculateExportSize,
  EXPORT_PRESETS,
  getExportPreset,
  MAX_EXPORT_LONG_EDGE,
  MAX_EXPORT_PIXELS,
  PRESET_SCHEMA_VERSION,
} from "../presets";

describe("data-driven export presets", () => {
  it("defines versioned original, social, and compact presets", () => {
    expect(EXPORT_PRESETS.map(({ id }) => id)).toEqual(["original", "social", "compact"]);
    expect(
      EXPORT_PRESETS.every(
        ({ presetSchemaVersion }) => presetSchemaVersion === PRESET_SCHEMA_VERSION,
      ),
    ).toBe(true);
    expect(getExportPreset("social")).toMatchObject({
      size: { mode: "max-long-edge", pixels: 2048 },
      metadataPolicy: "strip",
    });
    expect(() => getExportPreset("missing")).toThrow("does not exist");
  });

  it("does not upscale an original image already inside all limits", () => {
    expect(calculateExportSize(4000, 3000, getExportPreset("original"))).toEqual({
      width: 4000,
      height: 3000,
      scale: 1,
      wasReduced: false,
    });
  });

  it("applies preset long-edge targets while preserving aspect ratio", () => {
    expect(calculateExportSize(4000, 3000, getExportPreset("social"))).toEqual({
      width: 2048,
      height: 1536,
      scale: 0.512,
      wasReduced: true,
    });
    expect(calculateExportSize(4000, 3000, getExportPreset("compact"))).toEqual({
      width: 1280,
      height: 960,
      scale: 0.32,
      wasReduced: true,
    });
  });

  it("enforces the 16384px long-edge cap", () => {
    const size = calculateExportSize(20000, 1000, getExportPreset("original"));

    expect(size.width).toBe(MAX_EXPORT_LONG_EDGE);
    expect(size.height).toBe(819);
    expect(size.wasReduced).toBe(true);
  });

  it("enforces the 64MP total-pixel cap", () => {
    const size = calculateExportSize(12000, 9000, getExportPreset("original"));

    expect(size.width * size.height).toBeLessThanOrEqual(MAX_EXPORT_PIXELS);
    expect(size.width / size.height).toBeCloseTo(4 / 3, 3);
    expect(size.wasReduced).toBe(true);
  });

  it("rejects invalid input dimensions", () => {
    expect(() => calculateExportSize(0, 100, getExportPreset("original"))).toThrow(
      "positive finite",
    );
    expect(() => calculateExportSize(Number.NaN, 100, getExportPreset("original"))).toThrow(
      "positive finite",
    );
  });
});
