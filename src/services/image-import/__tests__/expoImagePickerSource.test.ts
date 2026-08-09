import { createExpoImagePickerSource } from "../expoImagePickerSource";

const mockLaunchImageLibraryAsync = jest.fn();

jest.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: (...args: readonly unknown[]) => mockLaunchImageLibraryAsync(...args),
  UIImagePickerPreferredAssetRepresentationMode: { Current: "current" },
}));

describe("Expo image picker source", () => {
  beforeEach(() => {
    mockLaunchImageLibraryAsync.mockReset();
  });

  it("[F07-S06] requests network-backed assets and maps a Live Photo to its cover still", async () => {
    mockLaunchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          type: "livePhoto",
          uri: "file:///picker/live-photo-cover.heic",
          width: 4032,
          height: 3024,
          fileName: "IMG_0001.HEIC",
          exif: { DateTimeOriginal: "2026:08:09 12:00:00" },
          pairedVideoAsset: {
            type: "pairedVideo",
            uri: "file:///picker/live-photo-motion.mov",
            width: 4032,
            height: 3024,
          },
        },
      ],
    });

    const selected = await createExpoImagePickerSource().select();

    expect(mockLaunchImageLibraryAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaTypes: ["images", "livePhotos"],
        selectionLimit: 9,
        shouldDownloadFromNetwork: true,
        preferredAssetRepresentationMode: "current",
      }),
    );
    expect(selected).toEqual([
      {
        kind: "livePhoto",
        uri: "file:///picker/live-photo-cover.heic",
        width: 4032,
        height: 3024,
        fileName: "IMG_0001.HEIC",
        exif: { DateTimeOriginal: "2026:08:09 12:00:00" },
        pairedVideoUri: "file:///picker/live-photo-motion.mov",
      },
    ]);
  });

  it("[F07-S07] keeps the batch pending until the system picker resolves selected files", async () => {
    let finishSelection!: (result: unknown) => void;
    mockLaunchImageLibraryAsync.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSelection = resolve;
        }),
    );
    const source = createExpoImagePickerSource();

    const selecting = source.select();
    let settled = false;
    void selecting.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishSelection({
      canceled: false,
      assets: [
        {
          type: "image",
          uri: "file:///picker/downloaded-from-icloud.heic",
          width: 3024,
          height: 4032,
          fileName: "icloud.heic",
          pairedVideoAsset: null,
        },
      ],
    });

    await expect(selecting).resolves.toEqual([
      expect.objectContaining({
        kind: "image",
        uri: "file:///picker/downloaded-from-icloud.heic",
      }),
    ]);
  });

  it.each(["Photo selection failed", "Photo provider unavailable"])(
    "[F07-S07] propagates an opaque picker batch failure for explicit flow feedback: %s",
    async (message) => {
      mockLaunchImageLibraryAsync.mockRejectedValue(new Error(message));

      await expect(createExpoImagePickerSource().select()).rejects.toThrow(message);
    },
  );
});
