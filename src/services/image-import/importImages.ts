import { MAX_SOURCE_IMAGES, type SourceImage } from "@/core/document";

import { extractImageMetadata, type ImageMetadataSidecar } from "./metadata";

export type PickedImageKind = "image" | "livePhoto" | "unsupported";

export interface PickedImage {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
  readonly fileName?: string | null;
  readonly kind: PickedImageKind;
  readonly exif?: unknown;
  readonly pairedVideoUri?: string | null;
}

export interface ImageSelectionSource {
  readonly select: () => Promise<readonly PickedImage[]>;
}

export interface ImageImportFileAdapter {
  readonly ensureDirectory: (uri: string) => Promise<void>;
  readonly copy: (sourceUri: string, destinationUri: string) => Promise<void>;
  readonly writeText: (uri: string, content: string) => Promise<void>;
}

export interface PreviewGenerator {
  readonly generate: (
    sourceUri: string,
    destinationUri: string,
    maxLongEdge: number,
  ) => Promise<{ readonly width: number; readonly height: number }>;
}

export interface ImportedImage {
  readonly image: SourceImage;
  readonly metadata: ImageMetadataSidecar | null;
  readonly metadataUri: string | null;
  readonly sourceKind: "image" | "livePhoto";
}

export interface ImageImportError {
  readonly index: number;
  readonly sourceUri: string;
  readonly message: string;
}

export interface ImageImportResult {
  readonly imported: readonly ImportedImage[];
  readonly errors: readonly ImageImportError[];
}

export interface ImportImagesOptions {
  readonly files: ImageImportFileAdapter;
  readonly previews: PreviewGenerator;
  readonly assetsDirectoryUri: string;
  readonly previewsDirectoryUri: string;
  readonly createId?: (asset: PickedImage, index: number) => string;
}

let importSequence = 0;

function defaultCreateId(_asset: PickedImage, index: number): string {
  importSequence += 1;
  return `image-${Date.now()}-${index}-${importSequence}`;
}

function childUri(directoryUri: string, name: string): string {
  return `${directoryUri.replace(/\/$/, "")}/${name}`;
}

function originalExtension(asset: PickedImage): string {
  const candidate = asset.fileName ?? asset.uri.split(/[?#]/, 1)[0] ?? "";
  const match = /\.([a-zA-Z0-9]{1,10})$/.exec(candidate);
  return match?.[1]?.toLowerCase() ?? "jpg";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function importImages(
  source: ImageSelectionSource,
  {
    files,
    previews,
    assetsDirectoryUri,
    previewsDirectoryUri,
    createId = defaultCreateId,
  }: ImportImagesOptions,
): Promise<ImageImportResult> {
  await files.ensureDirectory(assetsDirectoryUri);
  await files.ensureDirectory(previewsDirectoryUri);

  const selected = await source.select();
  const imported: ImportedImage[] = [];
  const errors: ImageImportError[] = [];
  const usedIds = new Set<string>();

  for (const [index, asset] of selected.slice(0, MAX_SOURCE_IMAGES).entries()) {
    try {
      if (asset.kind === "unsupported") throw new Error("unsupported media type");
      if (
        !Number.isInteger(asset.width) ||
        !Number.isInteger(asset.height) ||
        asset.width <= 0 ||
        asset.height <= 0
      ) {
        throw new Error("image dimensions must be positive");
      }
      const id = createId(asset, index);
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("image id is not path-safe");
      if (usedIds.has(id)) throw new Error("image id must be unique");
      usedIds.add(id);

      const originalUri = childUri(assetsDirectoryUri, `${id}.${originalExtension(asset)}`);
      const previewUri = childUri(previewsDirectoryUri, `${id}.jpg`);
      await files.copy(asset.uri, originalUri);
      const previewSize = await previews.generate(originalUri, previewUri, 2048);
      if (
        previewSize.width <= 0 ||
        previewSize.height <= 0 ||
        Math.max(previewSize.width, previewSize.height) > 2048
      ) {
        throw new Error("preview dimensions exceed the 2048px limit");
      }

      const metadata = extractImageMetadata(asset.exif);
      const metadataUri =
        metadata === null ? null : childUri(assetsDirectoryUri, `${id}.metadata.json`);
      if (metadata !== null && metadataUri !== null) {
        await files.writeText(metadataUri, JSON.stringify(metadata));
      }

      imported.push({
        image: {
          id,
          originalUri,
          previewUri,
          width: asset.width,
          height: asset.height,
        },
        metadata,
        metadataUri,
        sourceKind: asset.kind,
      });
    } catch (error: unknown) {
      errors.push({ index, sourceUri: asset.uri, message: errorMessage(error) });
    }
  }

  for (let index = MAX_SOURCE_IMAGES; index < selected.length; index += 1) {
    errors.push({
      index,
      sourceUri: selected[index]?.uri ?? "",
      message: `image limit is ${MAX_SOURCE_IMAGES}`,
    });
  }

  return { imported, errors };
}
