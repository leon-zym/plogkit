import { DRAFT_THUMBNAIL_PROFILE } from "../draftLibrary";
import { calculateDraftThumbnailGeometry } from "../expoDraftThumbnailAdapter";

jest.mock("expo-file-system", () => ({ File: jest.fn() }));
jest.mock("@shopify/react-native-skia", () => ({
  ImageFormat: { JPEG: "jpeg" },
  Skia: {},
}));

describe("Expo Draft thumbnail adapter contract", () => {
  it("pins the versioned encoded representation profile", () => {
    expect(DRAFT_THUMBNAIL_PROFILE).toEqual({
      profileVersion: 1,
      squareSize: 360,
      originalLongEdge: 720,
      codec: "jpeg",
      quality: 0.82,
      colorSpace: "srgb",
      metadata: "strip",
    });
  });

  it("center-crops the complete scene for the square representation", () => {
    expect(
      calculateDraftThumbnailGeometry(1200, 2400, DRAFT_THUMBNAIL_PROFILE, "square"),
    ).toEqual({
      width: 360,
      height: 360,
      scale: 0.3,
      translateX: 0,
      translateY: -180,
    });
  });

  it("preserves original composition ratio, caps the long edge, and never upscales", () => {
    expect(
      calculateDraftThumbnailGeometry(1200, 2400, DRAFT_THUMBNAIL_PROFILE, "original"),
    ).toEqual({
      width: 360,
      height: 720,
      scale: 0.3,
      translateX: 0,
      translateY: 0,
    });
    expect(
      calculateDraftThumbnailGeometry(300, 200, DRAFT_THUMBNAIL_PROFILE, "original"),
    ).toEqual({
      width: 300,
      height: 200,
      scale: 1,
      translateX: 0,
      translateY: 0,
    });
  });
});
