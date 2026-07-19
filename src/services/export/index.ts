import type { PlogDocument } from "../../core/document";
import type { SceneImageAssetResolver } from "../../render/scene";
import { SKIA_EXPORT_CAPABILITIES } from "./capabilities";
import { SkiaExportEncodeStage } from "./encodeStage";
import { ExpoExportDestination } from "./expoDestination";
import { runExportPipeline, type ExportResult, type RunExportOptions } from "./pipeline";
import { SkiaExportRenderStage } from "./skiaStages";

export { injectBasicExif, stripExifApp1, type BasicExifMetadata } from "./exif";
export { SKIA_EXPORT_CAPABILITIES } from "./capabilities";
export { createExportPlan, ExportPlanningError, type ExportPlan } from "./plan";
export { runExportPipeline, type ExportResult, type RunExportOptions } from "./pipeline";
export type {
  ExportArtifact,
  ExportDestination,
  ExportEncodeStage,
  ExportPipelineDependencies,
  ExportRenderStage,
  RenderedPixels,
} from "./types";

const defaultDependencies = {
  capabilities: SKIA_EXPORT_CAPABILITIES,
  renderer: new SkiaExportRenderStage(),
  encoder: new SkiaExportEncodeStage(),
  destination: new ExpoExportDestination(),
};

export function exportDocument(
  document: PlogDocument,
  assets: SceneImageAssetResolver,
  options: RunExportOptions = {},
): Promise<ExportResult> {
  return runExportPipeline(document, assets, options, defaultDependencies);
}
