import type {
  ExportDynamicPhoto,
  ExportDynamicRange,
  ExportFormat,
  ExportPostProcessRule,
  ExportPrecompression,
  ExportPresetId,
  MetadataPolicy,
} from "../exportPolicy";

export type ExportSizeRule =
  { readonly mode: "original" } | { readonly mode: "max-long-edge"; readonly pixels: number };

export interface BundledExportPresetDeclaration {
  readonly id: string;
  readonly presetRevision: number;
  readonly labelKey: string;
  readonly target: "generic";
  readonly allowedFormats: readonly ExportFormat[];
  readonly defaultFormat: ExportFormat;
  readonly size: ExportSizeRule;
  readonly quality: number;
  readonly dynamicRange: ExportDynamicRange;
  readonly dynamicPhoto: ExportDynamicPhoto;
  readonly precompression: ExportPrecompression;
  readonly metadataPolicies: Readonly<Partial<Record<ExportFormat, readonly MetadataPolicy[]>>>;
  readonly postProcess: readonly ExportPostProcessRule[];
}

export interface BundledExportPresetCatalogDeclaration {
  readonly catalogSchemaVersion: number;
  readonly presets: readonly BundledExportPresetDeclaration[];
}

export interface ExportPresetCatalogEntry extends Omit<BundledExportPresetDeclaration, "id"> {
  readonly id: ExportPresetId;
}

export interface ExportPresetCatalogSnapshot {
  readonly catalogSchemaVersion: number;
  readonly presets: readonly ExportPresetCatalogEntry[];
}

function invalidCatalog(message: string): never {
  throw new Error(`invalid bundled export preset catalog: ${message}`);
}

function freezeCatalogEntry(declaration: BundledExportPresetDeclaration): ExportPresetCatalogEntry {
  if (declaration.id.length === 0) invalidCatalog("preset id must not be empty");
  if (!Number.isInteger(declaration.presetRevision) || declaration.presetRevision <= 0) {
    invalidCatalog(`${declaration.id} presetRevision must be a positive integer`);
  }
  if (declaration.labelKey.length === 0) invalidCatalog(`${declaration.id} labelKey is required`);
  if (
    declaration.allowedFormats.length === 0 ||
    new Set(declaration.allowedFormats).size !== declaration.allowedFormats.length
  ) {
    invalidCatalog(`${declaration.id} allowedFormats must be non-empty and unique`);
  }
  if (!declaration.allowedFormats.includes(declaration.defaultFormat)) {
    invalidCatalog(`${declaration.id} defaultFormat must be allowed`);
  }
  if (
    !Number.isFinite(declaration.quality) ||
    declaration.quality <= 0 ||
    declaration.quality > 1
  ) {
    invalidCatalog(`${declaration.id} quality must be in (0, 1]`);
  }
  if (
    declaration.size.mode === "max-long-edge" &&
    (!Number.isInteger(declaration.size.pixels) || declaration.size.pixels <= 0)
  ) {
    invalidCatalog(`${declaration.id} size limit must be a positive integer`);
  }
  if (
    declaration.postProcess.some((rule) => rule.length === 0) ||
    new Set(declaration.postProcess).size !== declaration.postProcess.length
  ) {
    invalidCatalog(`${declaration.id} post-process rules must be non-empty and unique`);
  }

  const metadataPolicies: Partial<Record<ExportFormat, readonly MetadataPolicy[]>> = {};
  for (const format of declaration.allowedFormats) {
    const policies = declaration.metadataPolicies[format];
    if (
      policies === undefined ||
      policies.length === 0 ||
      new Set(policies).size !== policies.length ||
      !policies.includes("strip")
    ) {
      invalidCatalog(
        `${declaration.id} ${format} metadata policies must be unique and include strip`,
      );
    }
    metadataPolicies[format] = Object.freeze([...policies]);
  }
  for (const format of ["jpeg", "png"] as const) {
    if (!declaration.allowedFormats.includes(format) && declaration.metadataPolicies[format]) {
      invalidCatalog(`${declaration.id} declares metadata rules for disallowed ${format}`);
    }
  }

  return Object.freeze({
    ...declaration,
    id: declaration.id as ExportPresetId,
    allowedFormats: Object.freeze([...declaration.allowedFormats]),
    size: Object.freeze({ ...declaration.size }),
    metadataPolicies: Object.freeze(metadataPolicies),
    postProcess: Object.freeze([...declaration.postProcess]),
  });
}

export function buildExportPresetCatalogSnapshot(
  declaration: BundledExportPresetCatalogDeclaration,
): ExportPresetCatalogSnapshot {
  if (
    !Number.isInteger(declaration.catalogSchemaVersion) ||
    declaration.catalogSchemaVersion <= 0
  ) {
    invalidCatalog("catalogSchemaVersion must be a positive integer");
  }
  const presets = declaration.presets.map(freezeCatalogEntry);
  if (presets.length === 0) invalidCatalog("at least one preset is required");
  if (new Set(presets.map(({ id }) => id)).size !== presets.length) {
    invalidCatalog("preset ids must be unique");
  }
  return Object.freeze({
    catalogSchemaVersion: declaration.catalogSchemaVersion,
    presets: Object.freeze(presets),
  });
}
