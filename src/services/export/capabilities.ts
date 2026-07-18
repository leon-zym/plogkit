import type { ExportCapabilities } from "../../core/exportPolicy";

export const SKIA_EXPORT_CAPABILITIES: ExportCapabilities = Object.freeze({
  formats: Object.freeze(["jpeg", "png"] as const),
  metadataPolicies: Object.freeze({
    jpeg: Object.freeze(["strip", "retain-basic"] as const),
    png: Object.freeze(["strip"] as const),
  }),
  dynamicRanges: Object.freeze(["sdr"] as const),
  dynamicPhotos: Object.freeze(["still"] as const),
  precompressionModes: Object.freeze(["none", "upload"] as const),
  postProcessRules: Object.freeze([] as const),
});
