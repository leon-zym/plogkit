import type {
  ExportFormat,
  ExportPresetId,
  MetadataPolicy,
  PlogDocument,
} from "../../core/document";
import { calculateExportSize, getExportPreset } from "../../core/presets";
import { documentToRenderScene, getNaturalSceneSize } from "../../render/scene";

export interface ExportPlanOverrides {
  readonly presetId?: ExportPresetId;
  readonly format?: ExportFormat;
  readonly metadataPolicy?: MetadataPolicy;
}

export interface ExportPlan {
  readonly presetId: ExportPresetId;
  readonly width: number;
  readonly height: number;
  readonly wasReduced: boolean;
  readonly format: ExportFormat;
  readonly quality: number;
  readonly metadataPolicy: MetadataPolicy;
  readonly extension: "jpg" | "png";
  readonly mimeType: "image/jpeg" | "image/png";
}

/** Pure planning step shared by UI previews and the concrete export pipeline. */
export function createExportPlan(
  document: PlogDocument,
  overrides: ExportPlanOverrides = {},
): ExportPlan {
  const presetId = overrides.presetId ?? document.exportSettings.presetId;
  const preset = getExportPreset(presetId);
  const scene = documentToRenderScene(document, "original");
  const naturalSize = getNaturalSceneSize(scene);
  const size = calculateExportSize(naturalSize.width, naturalSize.height, preset);
  const format = overrides.format ?? document.exportSettings.format ?? preset.format;

  return {
    presetId,
    width: size.width,
    height: size.height,
    wasReduced: size.wasReduced,
    format,
    quality: preset.quality,
    metadataPolicy:
      overrides.metadataPolicy ?? document.exportSettings.metadataPolicy ?? preset.metadataPolicy,
    extension: format === "jpeg" ? "jpg" : "png",
    mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
  };
}
