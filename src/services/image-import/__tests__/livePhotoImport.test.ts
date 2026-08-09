import { importedAssetId } from "@/core/document";
import { SKIA_EXPORT_CAPABILITIES } from "@/services/export/capabilities";
import { createExportPipeline } from "@/services/export/pipeline";
import type { ExportBackend, ExportOperation, PhotosDestination } from "@/services/export/types";

import {
  createDraftLibrary,
  draftId,
  type DraftLibraryFileAdapter,
  type DraftLibraryPreviewAdapter,
  type DraftThumbnailAdapter,
  type ImportCandidate,
} from "../../drafts/draftLibrary";

type StoredValue = string | Uint8Array;

class MemoryFiles implements DraftLibraryFileAdapter {
  readonly files = new Map<string, StoredValue>();
  readonly directories = new Set<string>();
  readonly copiedSources: string[] = [];

  async fileExists(uri: string): Promise<boolean> {
    return this.files.has(uri);
  }

  async directoryExists(uri: string): Promise<boolean> {
    return this.directories.has(uri);
  }

  async ensureDirectory(uri: string): Promise<void> {
    this.directories.add(uri);
  }

  async readText(uri: string): Promise<string> {
    const value = this.files.get(uri);
    if (typeof value !== "string") throw new Error(`missing text ${uri}`);
    return value;
  }

  async writeText(uri: string, content: string): Promise<void> {
    this.files.set(uri, content);
  }

  async copy(sourceUri: string, destinationUri: string): Promise<void> {
    const value = this.files.get(sourceUri);
    if (value === undefined) throw new Error(`missing source ${sourceUri}`);
    this.copiedSources.push(sourceUri);
    this.files.set(destinationUri, value);
  }

  async moveFile(sourceUri: string, destinationUri: string): Promise<void> {
    const value = this.files.get(sourceUri);
    if (value === undefined) throw new Error(`missing file ${sourceUri}`);
    this.files.delete(sourceUri);
    this.files.set(destinationUri, value);
  }

  async moveDirectory(sourceUri: string, destinationUri: string): Promise<void> {
    if (!this.directories.has(sourceUri)) throw new Error(`missing directory ${sourceUri}`);
    this.directories.delete(sourceUri);
    this.directories.add(destinationUri);
    for (const directory of [...this.directories]) {
      if (!directory.startsWith(`${sourceUri}/`)) continue;
      this.directories.delete(directory);
      this.directories.add(`${destinationUri}${directory.slice(sourceUri.length)}`);
    }
    for (const [uri, value] of [...this.files]) {
      if (!uri.startsWith(`${sourceUri}/`)) continue;
      this.files.delete(uri);
      this.files.set(`${destinationUri}${uri.slice(sourceUri.length)}`, value);
    }
  }

  async removeFile(uri: string): Promise<void> {
    this.files.delete(uri);
  }

  async removeDirectory(uri: string): Promise<void> {
    this.directories.delete(uri);
    for (const directory of [...this.directories]) {
      if (directory.startsWith(`${uri}/`)) this.directories.delete(directory);
    }
    for (const path of [...this.files.keys()]) {
      if (path.startsWith(`${uri}/`)) this.files.delete(path);
    }
  }

  async listDirectories(uri: string): Promise<readonly string[]> {
    const prefix = `${uri.replace(/\/$/, "")}/`;
    const children = new Set<string>();
    for (const directory of this.directories) {
      if (!directory.startsWith(prefix)) continue;
      const child = directory.slice(prefix.length).split("/", 1)[0];
      if (child !== undefined && child.length > 0) children.add(`${prefix}${child}`);
    }
    return [...children];
  }

  async listFiles(uri: string): Promise<readonly string[]> {
    const prefix = `${uri.replace(/\/$/, "")}/`;
    return [...this.files.keys()].filter((path) => {
      if (!path.startsWith(prefix)) return false;
      const relative = path.slice(prefix.length);
      return relative.length > 0 && !relative.includes("/");
    });
  }
}

describe("Live Photo import contract", () => {
  it("[F07-S06] owns only the cover still and supplies it to editing previews and export", async () => {
    const coverUri = "picker://live-photo-cover.heic";
    const motionUri = "picker://live-photo-motion.mov";
    const coverBytes = new Uint8Array([1, 2, 3]);
    const motionBytes = new Uint8Array([9, 8, 7]);
    const previewSources: string[] = [];
    const files = new MemoryFiles();
    files.files.set(coverUri, coverBytes);
    files.files.set(motionUri, motionBytes);
    const previews: DraftLibraryPreviewAdapter = {
      generate: async (sourceUri, destinationUri) => {
        previewSources.push(sourceUri);
        files.files.set(destinationUri, new Uint8Array([4, 5, 6]));
        return { width: 2048, height: 1536 };
      },
      isValid: async (uri) => files.files.has(uri),
    };
    const thumbnails: DraftThumbnailAdapter = {
      generate: async ({ squareUri, originalUri }) => {
        files.files.set(squareUri, new Uint8Array([7]));
        files.files.set(originalUri, new Uint8Array([8]));
        return {
          square: { width: 360, height: 360 },
          original: { width: 720, height: 540 },
        };
      },
      inspect: async (uri) => (files.files.has(uri) ? { width: 360, height: 360 } : null),
    };
    const library = createDraftLibrary({
      files,
      previews,
      thumbnails,
      rootUri: "memory://library",
      createDraftId: () => draftId("draft:live-photo"),
      createAssetId: () => importedAssetId("asset:live-photo-cover"),
      createStorageKey: () => "live-photo-cover",
      createOperationId: () => "import-live-photo",
      createThumbnailGenerationId: () => "thumbnail-live-photo",
      now: () => "2026-08-09T12:00:00.000Z",
    });
    const candidate: ImportCandidate = {
      kind: "livePhoto",
      uri: coverUri,
      pairedVideoUri: motionUri,
      fileName: "IMG_0001.HEIC",
      width: 4032,
      height: 3024,
    };

    const created = await library.create([candidate], { metadataPolicy: "strip" });

    expect(created.status).toBe("created");
    if (created.status !== "created") throw new Error("expected a created Draft");
    const imageId = created.document.sourceImages[0]?.id;
    if (imageId === undefined) throw new Error("expected an imported source image");
    const preview = created.assets.resolve(imageId, "preview");
    const original = created.assets.resolve(imageId, "original");
    expect(created.document.sourceImages.map(({ id }) => id)).toEqual([imageId]);
    expect(files.copiedSources).toEqual([coverUri]);
    expect(files.copiedSources).not.toContain(motionUri);
    expect(previewSources).toHaveLength(1);
    expect(previewSources[0]).not.toBe(motionUri);
    expect(preview?.uri).toContain("/previews/live-photo-cover.jpg");
    expect(original?.uri).toContain("/assets/live-photo-cover.heic");
    expect(files.files.get(original!.uri)).toEqual(coverBytes);

    let capturedExportOriginal: string | null = null;
    const operation: ExportOperation = {
      id: "export-live-photo",
      directoryUri: "cache:///exports/export-live-photo",
      prepareStaticImage: jest.fn(async ({ mimeType, extension }) => ({
        kind: "static-image" as const,
        operationId: "export-live-photo",
        uri: `cache:///exports/export-live-photo/output.${extension}`,
        mimeType,
        extension,
      })),
      cleanup: jest.fn(async () => undefined),
    };
    const backend: ExportBackend = {
      identity: Object.freeze({ id: "live-photo-contract", revision: 1 }),
      capabilities: SKIA_EXPORT_CAPABILITIES,
      prepare: jest.fn(async ({ document, assets, operation: exportOperation, policy }) => {
        capturedExportOriginal = assets.resolve(imageId, "original")?.uri ?? null;
        return {
          status: "prepared" as const,
          prepared: await exportOperation.prepareStaticImage({
            bytes: new Uint8Array([6, 5, 4]),
            mimeType: policy.mimeType,
            extension: policy.extension,
          }),
        };
      }),
    };
    const destination: PhotosDestination = {
      publish: jest.fn(async () => ({
        status: "published" as const,
        assetId: "photos:live-photo-still",
      })),
    };
    const pipeline = createExportPipeline({
      backend,
      destination,
      staging: { createOperation: jest.fn(async () => operation) },
    });

    await expect(
      pipeline.run({ document: created.document, assets: created.assets }),
    ).resolves.toMatchObject({ status: "success" });
    expect(capturedExportOriginal).toBe(original?.uri);
    expect(files.files.get(capturedExportOriginal!)).toEqual(coverBytes);
  });
});
