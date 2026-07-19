import type { PlogDocument } from "../../core/document";
import type { SceneImageAssetResolver } from "../../render/scene";
import type { BasicExifMetadata } from "./exif";
import { createExportPlan, type ExportPlan } from "./plan";
import type { ExportArtifact, ExportPipelineDependencies } from "./types";

export interface RunExportOptions {
  readonly basicMetadata?: BasicExifMetadata;
  readonly filename?: string;
}

export interface ExportResult extends ExportArtifact {
  readonly plan: ExportPlan;
}

/** Runs render -> encode -> file/save while always releasing rendered pixel ownership. */
export async function runExportPipeline(
  document: PlogDocument,
  assets: SceneImageAssetResolver,
  options: RunExportOptions,
  dependencies: ExportPipelineDependencies,
): Promise<ExportResult> {
  const plan = createExportPlan(document, dependencies.capabilities);
  const pixels = await dependencies.renderer.render(document, plan, assets);
  try {
    if (pixels.width !== plan.width || pixels.height !== plan.height) {
      throw new Error("render stage returned dimensions that do not match the export plan");
    }
    const encoded = dependencies.encoder.encode(pixels, plan, options.basicMetadata);
    const artifact = await dependencies.destination.writeAndSave(encoded, plan, options.filename);
    return { ...artifact, plan };
  } finally {
    pixels.dispose();
  }
}
