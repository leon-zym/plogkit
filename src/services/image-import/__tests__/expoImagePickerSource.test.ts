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

  it("requests network-backed assets and maps a Live Photo to its cover still", async () => {
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

  it("waits for an iCloud-backed selection to resolve to a local file", async () => {
    let finishDownload!: (result: unknown) => void;
    mockLaunchImageLibraryAsync.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDownload = resolve;
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

    finishDownload({
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

  it.each(["iCloud download timed out", "iCloud download failed"])(
    "propagates a picker failure for explicit flow feedback: %s",
    async (message) => {
      mockLaunchImageLibraryAsync.mockRejectedValue(new Error(message));

      await expect(createExpoImagePickerSource().select()).rejects.toThrow(message);
    },
  );
});
