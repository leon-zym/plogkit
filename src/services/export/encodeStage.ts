import { injectBasicExif } from "./exif";
import type { ExportPlan } from "./plan";
import type { ExportEncodeStage } from "./types";

export class SkiaExportEncodeStage implements ExportEncodeStage {
  encode(
    pixels: Parameters<ExportEncodeStage["encode"]>[0],
    plan: ExportPlan,
    metadata?: Parameters<ExportEncodeStage["encode"]>[2],
  ): Uint8Array {
    const encoded = pixels.encode(plan.format, plan.quality);
    if (plan.metadataPolicy === "retain-basic") {
      return injectBasicExif(encoded, metadata ?? {});
    }
    return encoded;
  }
}
