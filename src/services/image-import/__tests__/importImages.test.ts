import {
  importImages,
  type ImageImportFileAdapter,
  type ImageSelectionSource,
  type PickedImage,
  type PreviewGenerator,
} from "../importImages";

const picked = (id: string, overrides: Partial<PickedImage> = {}): PickedImage => ({
  uri: `picker://${id}.heic`,
  width: 4032,
  height: 3024,
  fileName: `${id}.heic`,
  kind: "image",
  exif: null,
  ...overrides,
});

describe("source-independent image import", () => {
  it("copies originals, creates bounded previews, and ignores a Live Photo video", async () => {
    const assets = [
      picked("normal", { exif: { Make: "Apple", GPSLatitude: 31.2 } }),
      picked("live", { kind: "livePhoto", pairedVideoUri: "picker://live.mov" }),
    ];
    const source: ImageSelectionSource = { select: async () => assets };
    const files: ImageImportFileAdapter = {
      ensureDirectory: jest.fn().mockResolvedValue(undefined),
      copy: jest.fn().mockResolvedValue(undefined),
      writeText: jest.fn().mockResolvedValue(undefined),
    };
    const previews: PreviewGenerator = {
      generate: jest.fn().mockResolvedValue({ width: 2048, height: 1536 }),
    };

    const result = await importImages(source, {
      files,
      previews,
      assetsDirectoryUri: "memory://assets",
      previewsDirectoryUri: "memory://previews",
      createId: (_asset, index) => `image-${index + 1}`,
    });

    expect(result.errors).toEqual([]);
    expect(result.imported.map(({ image }) => image)).toEqual([
      {
        id: "image-1",
        originalUri: "memory://assets/image-1.heic",
        previewUri: "memory://previews/image-1.jpg",
        width: 4032,
        height: 3024,
      },
      {
        id: "image-2",
        originalUri: "memory://assets/image-2.heic",
        previewUri: "memory://previews/image-2.jpg",
        width: 4032,
        height: 3024,
      },
    ]);
    expect(files.copy).toHaveBeenCalledWith("picker://live.heic", "memory://assets/image-2.heic");
    expect(files.copy).not.toHaveBeenCalledWith("picker://live.mov", expect.any(String));
    expect(previews.generate).toHaveBeenCalledWith(
      "memory://assets/image-1.heic",
      "memory://previews/image-1.jpg",
      2048,
    );
    expect(result.imported[0]?.metadata).toEqual({ deviceMake: "Apple" });
  });

  it("keeps successful items and returns per-item failures", async () => {
    const source: ImageSelectionSource = {
      select: async () => [picked("good"), picked("bad"), picked("invalid", { width: 0 })],
    };
    const files: ImageImportFileAdapter = {
      ensureDirectory: jest.fn().mockResolvedValue(undefined),
      copy: jest.fn(async (sourceUri) => {
        if (sourceUri.includes("bad")) throw new Error("copy failed");
      }),
      writeText: jest.fn().mockResolvedValue(undefined),
    };
    const previews: PreviewGenerator = {
      generate: jest.fn().mockResolvedValue({ width: 2048, height: 1536 }),
    };

    const result = await importImages(source, {
      files,
      previews,
      assetsDirectoryUri: "memory://assets",
      previewsDirectoryUri: "memory://previews",
      createId: (_asset, index) => `image-${index + 1}`,
    });

    expect(result.imported).toHaveLength(1);
    expect(result.errors).toEqual([
      { index: 1, sourceUri: "picker://bad.heic", message: "copy failed" },
      {
        index: 2,
        sourceUri: "picker://invalid.heic",
        message: "image dimensions must be positive",
      },
    ]);
  });

  it("imports at most nine items from any source", async () => {
    const source: ImageSelectionSource = {
      select: async () => Array.from({ length: 10 }, (_, index) => picked(`item-${index}`)),
    };
    const files: ImageImportFileAdapter = {
      ensureDirectory: jest.fn().mockResolvedValue(undefined),
      copy: jest.fn().mockResolvedValue(undefined),
      writeText: jest.fn().mockResolvedValue(undefined),
    };
    const previews: PreviewGenerator = {
      generate: jest.fn().mockResolvedValue({ width: 2048, height: 1536 }),
    };

    const result = await importImages(source, {
      files,
      previews,
      assetsDirectoryUri: "memory://assets",
      previewsDirectoryUri: "memory://previews",
      createId: (_asset, index) => `image-${index + 1}`,
    });

    expect(result.imported).toHaveLength(9);
    expect(result.errors[0]).toMatchObject({ index: 9, message: "image limit is 9" });
  });

  it("rejects duplicate ids and previews above the bounded size", async () => {
    const source: ImageSelectionSource = {
      select: async () => [picked("first"), picked("second")],
    };
    const files: ImageImportFileAdapter = {
      ensureDirectory: jest.fn().mockResolvedValue(undefined),
      copy: jest.fn().mockResolvedValue(undefined),
      writeText: jest.fn().mockResolvedValue(undefined),
    };
    const previews: PreviewGenerator = {
      generate: jest
        .fn()
        .mockResolvedValueOnce({ width: 4096, height: 3072 })
        .mockResolvedValueOnce({ width: 2048, height: 1536 }),
    };

    const result = await importImages(source, {
      files,
      previews,
      assetsDirectoryUri: "memory://assets",
      previewsDirectoryUri: "memory://previews",
      createId: () => "same-id",
    });

    expect(result.imported).toEqual([]);
    expect(result.errors.map(({ message }) => message)).toEqual([
      "preview dimensions exceed the 2048px limit",
      "image id must be unique",
    ]);
  });
});
