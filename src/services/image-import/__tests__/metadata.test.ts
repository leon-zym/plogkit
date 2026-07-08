import { extractImageMetadata } from "../metadata";

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
