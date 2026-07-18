import {
  buildExportPresetCatalogSnapshot,
  type BundledExportPresetCatalogDeclaration,
  type ExportPresetCatalogEntry,
  type ExportSizeRule,
} from "./exportPolicy/catalog";

declare const exportPresetIdBrand: unique symbol;

export type ExportPresetId = string & { readonly [exportPresetIdBrand]: true };
export type ExportFormat = "jpeg" | "png";
export type MetadataPolicy = "strip" | "retain-basic";
export type ExportDynamicRange = "sdr";
export type ExportDynamicPhoto = "still";
export type ExportPrecompression = "none" | "upload";
export type ExportPostProcessRule = string;

const MAX_EXPORT_PIXELS = 64_000_000;
const MAX_EXPORT_LONG_EDGE = 16_384;

export interface ExportSettings {
  readonly presetId: ExportPresetId;
  readonly metadataPolicy: MetadataPolicy;
  readonly formatOverride?: ExportFormat;
}

export interface ExportPresetOption {
  readonly id: ExportPresetId;
  readonly labelKey: string;
  readonly allowedFormats: readonly ExportFormat[];
  readonly defaultFormat: ExportFormat;
}

const BUNDLED_EXPORT_PRESET_DECLARATION: BundledExportPresetCatalogDeclaration = {
  catalogSchemaVersion: 1,
  presets: [
    {
      id: "original",
      presetRevision: 1,
      labelKey: "export.presets.original",
      target: "generic",
      allowedFormats: ["jpeg", "png"],
      defaultFormat: "jpeg",
      size: { mode: "original" },
      quality: 0.95,
      dynamicRange: "sdr",
      dynamicPhoto: "still",
      precompression: "none",
      metadataPolicies: {
        jpeg: ["strip", "retain-basic"],
        png: ["strip"],
      },
      postProcess: [],
    },
    {
      id: "social",
      presetRevision: 1,
      labelKey: "export.presets.social",
      target: "generic",
      allowedFormats: ["jpeg"],
      defaultFormat: "jpeg",
      size: { mode: "max-long-edge", pixels: 2048 },
      quality: 0.9,
      dynamicRange: "sdr",
      dynamicPhoto: "still",
      precompression: "upload",
      metadataPolicies: { jpeg: ["strip", "retain-basic"] },
      postProcess: [],
    },
    {
      id: "compact",
      presetRevision: 1,
      labelKey: "export.presets.compact",
      target: "generic",
      allowedFormats: ["jpeg"],
      defaultFormat: "jpeg",
      size: { mode: "max-long-edge", pixels: 1280 },
      quality: 0.8,
      dynamicRange: "sdr",
      dynamicPhoto: "still",
      precompression: "upload",
      metadataPolicies: { jpeg: ["strip", "retain-basic"] },
      postProcess: [],
    },
  ],
};

const CATALOG = buildExportPresetCatalogSnapshot(BUNDLED_EXPORT_PRESET_DECLARATION);

const PRESET_OPTIONS: readonly ExportPresetOption[] = Object.freeze(
  CATALOG.presets.map((preset) =>
    Object.freeze({
      id: preset.id,
      labelKey: preset.labelKey,
      allowedFormats: preset.allowedFormats,
      defaultFormat: preset.defaultFormat,
    }),
  ),
);

export function listPresetOptions(): readonly ExportPresetOption[] {
  return PRESET_OPTIONS;
}

export function parseExportSettings(input: unknown): ExportSettings {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("export settings must be an object");
  }
  const record = input as Record<string, unknown>;
  if (record.format !== undefined) {
    throw new Error("export settings format is not supported; use formatOverride");
  }
  if (typeof record.presetId !== "string" || record.presetId.length === 0) {
    throw new Error("export settings presetId must be a non-empty string");
  }
  if (record.metadataPolicy !== "strip" && record.metadataPolicy !== "retain-basic") {
    throw new Error("export settings metadataPolicy is not supported");
  }
  if (
    record.formatOverride !== undefined &&
    record.formatOverride !== "jpeg" &&
    record.formatOverride !== "png"
  ) {
    throw new Error("export settings formatOverride is not supported");
  }
  return {
    presetId: record.presetId as ExportPresetId,
    metadataPolicy: record.metadataPolicy,
    ...(record.formatOverride === undefined ? {} : { formatOverride: record.formatOverride }),
  };
}

export interface ExportSourceFacts {
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

export interface ExportCapabilities {
  readonly formats: readonly ExportFormat[];
  readonly metadataPolicies: Readonly<Partial<Record<ExportFormat, readonly MetadataPolicy[]>>>;
  readonly dynamicRanges: readonly ExportDynamicRange[];
  readonly dynamicPhotos: readonly ExportDynamicPhoto[];
  readonly precompressionModes: readonly ExportPrecompression[];
  readonly postProcessRules: readonly ExportPostProcessRule[];
}

export interface ResolvedExportPolicy {
  readonly catalogSchemaVersion: number;
  readonly presetId: ExportPresetId;
  readonly presetRevision: number;
  readonly target: "generic";
  readonly width: number;
  readonly height: number;
  readonly wasReduced: boolean;
  readonly format: ExportFormat;
  readonly quality: number;
  readonly dynamicRange: ExportDynamicRange;
  readonly dynamicPhoto: ExportDynamicPhoto;
  readonly precompression: ExportPrecompression;
  readonly metadataPolicy: MetadataPolicy;
  readonly postProcess: readonly ExportPostProcessRule[];
  readonly extension: "jpg" | "png";
  readonly mimeType: "image/jpeg" | "image/png";
}

export type UnsupportedExportPolicyReason =
  | "format-not-allowed"
  | "metadata-not-allowed"
  | "format-unsupported"
  | "metadata-unsupported"
  | "dynamic-range-unsupported"
  | "dynamic-photo-unsupported"
  | "precompression-unsupported"
  | "post-process-unsupported";

export type ExportPolicyError =
  | {
      readonly code: "preset-unavailable";
      readonly requestedPresetId: ExportPresetId;
      readonly catalogSchemaVersion: number;
    }
  | {
      readonly code: "unsupported-policy";
      readonly reason: UnsupportedExportPolicyReason;
      readonly presetId: ExportPresetId;
      readonly presetRevision: number;
      readonly catalogSchemaVersion: number;
    };

export type ExportPolicyResolution =
  | { readonly status: "resolved"; readonly policy: ResolvedExportPolicy }
  | { readonly status: "failed"; readonly error: ExportPolicyError };

function unsupported(
  preset: ExportPresetCatalogEntry,
  reason: UnsupportedExportPolicyReason,
): ExportPolicyResolution {
  return {
    status: "failed",
    error: {
      code: "unsupported-policy",
      reason,
      presetId: preset.id,
      presetRevision: preset.presetRevision,
      catalogSchemaVersion: CATALOG.catalogSchemaVersion,
    },
  };
}

function calculateSize(source: ExportSourceFacts, rule: ExportSizeRule) {
  if (
    !Number.isFinite(source.naturalWidth) ||
    source.naturalWidth <= 0 ||
    !Number.isFinite(source.naturalHeight) ||
    source.naturalHeight <= 0
  ) {
    throw new Error("export source dimensions must be positive finite numbers");
  }
  const longEdge = Math.max(source.naturalWidth, source.naturalHeight);
  const presetScale = rule.mode === "max-long-edge" ? rule.pixels / longEdge : 1;
  const longEdgeScale = MAX_EXPORT_LONG_EDGE / longEdge;
  const pixelScale = Math.sqrt(MAX_EXPORT_PIXELS / (source.naturalWidth * source.naturalHeight));
  const scale = Math.min(1, presetScale, longEdgeScale, pixelScale);
  return {
    width: Math.max(1, Math.floor(source.naturalWidth * scale)),
    height: Math.max(1, Math.floor(source.naturalHeight * scale)),
    wasReduced: scale < 1,
  };
}

export function resolveExportPolicy(
  settings: ExportSettings,
  sourceFacts: ExportSourceFacts,
  capabilities: ExportCapabilities,
): ExportPolicyResolution {
  const preset = CATALOG.presets.find(({ id }) => id === settings.presetId);
  if (preset === undefined) {
    return {
      status: "failed",
      error: {
        code: "preset-unavailable",
        requestedPresetId: settings.presetId,
        catalogSchemaVersion: CATALOG.catalogSchemaVersion,
      },
    };
  }

  const format = settings.formatOverride ?? preset.defaultFormat;
  if (!preset.allowedFormats.includes(format)) return unsupported(preset, "format-not-allowed");
  const allowedMetadata = preset.metadataPolicies[format];
  if (allowedMetadata === undefined || !allowedMetadata.includes(settings.metadataPolicy)) {
    return unsupported(preset, "metadata-not-allowed");
  }
  if (!capabilities.formats.includes(format)) return unsupported(preset, "format-unsupported");
  if (!capabilities.metadataPolicies[format]?.includes(settings.metadataPolicy)) {
    return unsupported(preset, "metadata-unsupported");
  }
  if (!capabilities.dynamicRanges.includes(preset.dynamicRange)) {
    return unsupported(preset, "dynamic-range-unsupported");
  }
  if (!capabilities.dynamicPhotos.includes(preset.dynamicPhoto)) {
    return unsupported(preset, "dynamic-photo-unsupported");
  }
  if (!capabilities.precompressionModes.includes(preset.precompression)) {
    return unsupported(preset, "precompression-unsupported");
  }
  if (preset.postProcess.some((rule) => !capabilities.postProcessRules.includes(rule))) {
    return unsupported(preset, "post-process-unsupported");
  }

  const size = calculateSize(sourceFacts, preset.size);
  return {
    status: "resolved",
    policy: Object.freeze({
      catalogSchemaVersion: CATALOG.catalogSchemaVersion,
      presetId: preset.id,
      presetRevision: preset.presetRevision,
      target: preset.target,
      ...size,
      format,
      quality: preset.quality,
      dynamicRange: preset.dynamicRange,
      dynamicPhoto: preset.dynamicPhoto,
      precompression: preset.precompression,
      metadataPolicy: settings.metadataPolicy,
      postProcess: preset.postProcess,
      extension: format === "jpeg" ? "jpg" : "png",
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
    }),
  };
}
