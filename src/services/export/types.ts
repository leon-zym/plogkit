import type { PlogDocument } from "../../core/document";
import type { BasicExifMetadata } from "./exif";
import type { ExportPlan } from "./plan";

export interface RenderedPixels {
  readonly width: number;
  readonly height: number;
  encode(format: ExportPlan["format"], quality: number): Uint8Array;
  dispose(): void;
}

export interface ExportRenderStage {
  render(document: PlogDocument, plan: ExportPlan): Promise<RenderedPixels>;
}

export interface ExportEncodeStage {
  encode(
    pixels: RenderedPixels,
    plan: ExportPlan,
    metadata?: BasicExifMetadata,
  ): Uint8Array;
}

export interface ExportDestination {
  writeAndSave(bytes: Uint8Array, plan: ExportPlan, filename?: string): Promise<ExportArtifact>;
}

export interface ExportArtifact {
  readonly fileUri: string;
  readonly assetId: string;
}

export interface ExportPipelineDependencies {
  readonly renderer: ExportRenderStage;
  readonly encoder: ExportEncodeStage;
  readonly destination: ExportDestination;
}
