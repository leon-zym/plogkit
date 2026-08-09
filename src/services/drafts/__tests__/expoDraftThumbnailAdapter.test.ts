import { createDocument } from "@/core/document";
import type { SkiaOffscreenSceneRenderer } from "@/render/skiaOffscreenRenderer";

import { DRAFT_THUMBNAIL_PROFILE, draftId } from "../draftLibrary";
import {
  calculateDraftThumbnailGeometry,
  createExpoDraftThumbnailAdapter,
} from "../expoDraftThumbnailAdapter";

jest.mock("expo-file-system", () => ({ File: jest.fn() }));
jest.mock("@shopify/react-native-skia", () => ({
  ImageFormat: { JPEG: "jpeg" },
  Skia: {},
}));

describe("Expo Draft thumbnail adapter contract", () => {
  const MockFile = jest.requireMock("expo-file-system").File as jest.Mock;

  beforeEach(() => {
    MockFile.mockImplementation(() => ({
      create: jest.fn(),
      write: jest.fn(),
    }));
  });

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
    expect(calculateDraftThumbnailGeometry(1200, 2400, DRAFT_THUMBNAIL_PROFILE, "square")).toEqual({
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
    expect(calculateDraftThumbnailGeometry(300, 200, DRAFT_THUMBNAIL_PROFILE, "original")).toEqual({
      width: 300,
      height: 200,
      scale: 1,
      translateX: 0,
      translateY: 0,
    });
  });

  it("[F08-S14] renders and writes the square/original pair as one concrete target batch", async () => {
    const squareBytes = Uint8Array.from([1, 2]);
    const originalBytes = Uint8Array.from([3, 4]);
    const renderer: SkiaOffscreenSceneRenderer = {
      render: jest.fn(async () => ({
        status: "rendered" as const,
        outputs: {
          square: {
            targetId: "square",
            width: 360,
            height: 360,
            bytes: squareBytes,
          },
          original: {
            targetId: "original",
            width: 720,
            height: 720,
            bytes: originalBytes,
          },
        },
      })),
    };
    const adapter = createExpoDraftThumbnailAdapter({ renderer });
    const assets = { entries: [], resolve: () => null };

    const result = await adapter.generate({
      draftId: draftId("draft-thumbnail"),
      contentRevision: 7,
      document: createDocument(),
      assets,
      profile: DRAFT_THUMBNAIL_PROFILE,
      squareUri: "file:///square.jpg",
      originalUri: "file:///original.jpg",
    });

    expect(result).toEqual({
      square: { width: 360, height: 360 },
      original: { width: 720, height: 720 },
    });
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(renderer.render).toHaveBeenCalledWith({
      scene: expect.objectContaining({ width: 1000, height: 1000 }),
      assets,
      targets: [
        {
          id: "square",
          width: 360,
          height: 360,
          transform: {
            scaleX: 0.36,
            scaleY: 0.36,
            translateX: 0,
            translateY: 0,
          },
          encoding: { format: "jpeg", quality: 0.82 },
        },
        {
          id: "original",
          width: 720,
          height: 720,
          transform: {
            scaleX: 0.72,
            scaleY: 0.72,
            translateX: 0,
            translateY: 0,
          },
          encoding: { format: "jpeg", quality: 0.82 },
        },
      ],
    });
    expect(MockFile).toHaveBeenNthCalledWith(1, "file:///square.jpg");
    expect(MockFile).toHaveBeenNthCalledWith(2, "file:///original.jpg");
    expect(MockFile.mock.results[0]?.value.write).toHaveBeenCalledWith(squareBytes);
    expect(MockFile.mock.results[1]?.value.write).toHaveBeenCalledWith(originalBytes);
  });

  it("does not write either representation when the renderer batch fails", async () => {
    const renderer: SkiaOffscreenSceneRenderer = {
      render: jest.fn(async () => ({
        status: "failure" as const,
        code: "original-asset-decode-failed" as const,
        phase: "assets" as const,
        assetId: "asset-1" as never,
        message: "fixture could not decode",
      })),
    };
    const adapter = createExpoDraftThumbnailAdapter({ renderer });

    await expect(
      adapter.generate({
        draftId: draftId("draft-failed-thumbnail"),
        contentRevision: 1,
        document: createDocument(),
        assets: { entries: [], resolve: () => null },
        profile: DRAFT_THUMBNAIL_PROFILE,
        squareUri: "file:///square.jpg",
        originalUri: "file:///original.jpg",
      }),
    ).rejects.toThrow(
      "thumbnail rendering failed: original-asset-decode-failed: fixture could not decode",
    );
    expect(MockFile).not.toHaveBeenCalled();
  });
});
