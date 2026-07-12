import type { PlogDocument } from "../../core/document";
import { SkiaExportEncodeStage } from "./encodeStage";
import { ExpoExportDestination } from "./expoDestination";
import { runExportPipeline, type ExportResult, type RunExportOptions } from "./pipeline";
import { SkiaExportRenderStage } from "./skiaStages";

export { injectBasicExif, stripExifApp1, type BasicExifMetadata } from "./exif";
export { createExportPlan, type ExportPlan, type ExportPlanOverrides } from "./plan";
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
  renderer: new SkiaExportRenderStage(),
  encoder: new SkiaExportEncodeStage(),
  destination: new ExpoExportDestination(),
};

export function exportDocument(
  document: PlogDocument,
  options: RunExportOptions = {},
): Promise<ExportResult> {
  return runExportPipeline(document, options, defaultDependencies);
}
