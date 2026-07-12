import type { ExportFormat, ExportPresetId, MetadataPolicy } from "./document";

export const PRESET_SCHEMA_VERSION = 1;
export const MAX_EXPORT_PIXELS = 64_000_000;
export const MAX_EXPORT_LONG_EDGE = 16_384;

export type ExportSizeRule =
  { readonly mode: "original" } | { readonly mode: "max-long-edge"; readonly pixels: number };

export interface ExportPreset {
  readonly presetSchemaVersion: typeof PRESET_SCHEMA_VERSION;
  readonly id: ExportPresetId;
  readonly labelKey: string;
  readonly targetPlatform: "generic";
  readonly size: ExportSizeRule;
  readonly format: ExportFormat;
  readonly quality: number;
  readonly postProcess: readonly string[];
  readonly metadataPolicy: MetadataPolicy;
}

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  {
    presetSchemaVersion: PRESET_SCHEMA_VERSION,
    id: "original",
    labelKey: "export.presets.original",
    targetPlatform: "generic",
    size: { mode: "original" },
    format: "jpeg",
    quality: 0.95,
    postProcess: [],
    metadataPolicy: "strip",
  },
  {
    presetSchemaVersion: PRESET_SCHEMA_VERSION,
    id: "social",
    labelKey: "export.presets.social",
    targetPlatform: "generic",
    size: { mode: "max-long-edge", pixels: 2048 },
    format: "jpeg",
    quality: 0.9,
    postProcess: [],
    metadataPolicy: "strip",
  },
  {
    presetSchemaVersion: PRESET_SCHEMA_VERSION,
    id: "compact",
    labelKey: "export.presets.compact",
    targetPlatform: "generic",
    size: { mode: "max-long-edge", pixels: 1280 },
    format: "jpeg",
    quality: 0.8,
    postProcess: [],
    metadataPolicy: "strip",
  },
];

export interface ExportSize {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly wasReduced: boolean;
}

export function getExportPreset(id: string): ExportPreset {
  const preset = EXPORT_PRESETS.find((candidate) => candidate.id === id);
  if (preset === undefined) {
    throw new Error(`export preset ${id} does not exist`);
  }
  return preset;
}

function requirePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

export function calculateExportSize(
  sourceWidth: number,
  sourceHeight: number,
  preset: ExportPreset,
): ExportSize {
  requirePositiveFinite(sourceWidth, "source width");
  requirePositiveFinite(sourceHeight, "source height");

  const longEdge = Math.max(sourceWidth, sourceHeight);
  const presetScale = preset.size.mode === "max-long-edge" ? preset.size.pixels / longEdge : 1;
  const longEdgeScale = MAX_EXPORT_LONG_EDGE / longEdge;
  const pixelScale = Math.sqrt(MAX_EXPORT_PIXELS / (sourceWidth * sourceHeight));
  const scale = Math.min(1, presetScale, longEdgeScale, pixelScale);
  return {
    width: Math.max(1, Math.floor(sourceWidth * scale)),
    height: Math.max(1, Math.floor(sourceHeight * scale)),
    scale,
    wasReduced: scale < 1,
  };
}
