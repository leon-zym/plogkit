import { extractImageMetadata, parseImageMetadataSidecar, toExifDateTime } from "../metadata";

describe("image metadata sidecar", () => {
  it("keeps only shooting time and device fields", () => {
    expect(
      extractImageMetadata({
        DateTimeOriginal: "2026:07:11 10:30:00",
        Make: "Apple",
        Model: "iPhone",
        LensModel: "iPhone Main Camera",
        Software: "Camera",
        GPSLatitude: 31.2,
        GPSLongitude: 121.5,
        UserComment: "private",
      }),
    ).toEqual({
      capturedAt: "2026:07:11 10:30:00",
      deviceMake: "Apple",
      deviceModel: "iPhone",
      lensModel: "iPhone Main Camera",
      software: "Camera",
    });
  });

  it("returns null for absent or unusable metadata", () => {
    expect(extractImageMetadata(null)).toBeNull();
    expect(extractImageMetadata({ GPSLatitude: 31.2 })).toBeNull();
  });
});

describe("metadata sidecar", () => {
  it("parses only the persisted whitelist", () => {
    expect(
      parseImageMetadataSidecar({
        capturedAt: "2026:07:11 12:30:00",
        deviceMake: "Example",
        latitude: 31.2,
      }),
    ).toEqual({ capturedAt: "2026:07:11 12:30:00", deviceMake: "Example" });
  });

  it("normalizes ISO timestamps for EXIF and rejects invalid dates", () => {
    expect(toExifDateTime("2026:07:11 12:30:00")).toBe("2026:07:11 12:30:00");
    expect(toExifDateTime("2026-07-11T12:30:00+08:00")).toMatch(/^2026:07:11 \d{2}:30:00$/);
    expect(toExifDateTime("not-a-date")).toBeUndefined();
  });
});
