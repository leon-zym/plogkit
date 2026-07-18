import { File } from "expo-file-system";

import type { PlogDocument } from "../../core/document";
import type { AssetCatalogSnapshot } from "../drafts/draftLibrary";
import { ExpoPhotosDestination } from "./expoDestination";
import { getExpoExportStaging } from "./expoStaging";
import {
  createExportPipeline,
  type ExportResult,
} from "./pipeline";
import { createSkiaExportBackend } from "./skiaBackend";

export { injectBasicExif, stripExifApp1, type BasicExifMetadata } from "./exif";
export { SKIA_EXPORT_CAPABILITIES } from "./capabilities";
export {
  createExportPipeline,
  type ExportFailure,
  type ExportPhase,
  type ExportRequest,
  type ExportResult,
} from "./pipeline";
export { createSkiaExportBackend } from "./skiaBackend";
export type {
  ExportBackend,
  ExportOperation,
  ExportStaging,
  PhotosDestination,
  PreparedExport,
} from "./types";

export interface ExportRunOptions {
  readonly signal?: AbortSignal;
}

const backend = createSkiaExportBackend({
  readMetadataText: async (uri) => {
    const file = new File(uri);
    return file.exists ? file.text() : null;
  },
});

const pipeline = createExportPipeline({
  backend,
  destination: new ExpoPhotosDestination(),
  staging: getExpoExportStaging(),
});

export function exportDocument(
  document: PlogDocument,
  assets: AssetCatalogSnapshot,
  options: ExportRunOptions = {},
): Promise<ExportResult> {
  return pipeline.run({ document, assets, signal: options.signal });
}
