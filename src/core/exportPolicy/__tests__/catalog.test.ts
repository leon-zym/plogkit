import {
  buildExportPresetCatalogSnapshot,
  type BundledExportPresetCatalogDeclaration,
  type BundledExportPresetDeclaration,
} from "../catalog";

function preset(
  overrides: Partial<BundledExportPresetDeclaration> = {},
): BundledExportPresetDeclaration {
  return {
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
    ...overrides,
  };
}

function catalog(
  presets: readonly BundledExportPresetDeclaration[],
): BundledExportPresetCatalogDeclaration {
  return { catalogSchemaVersion: 1, presets };
}

describe("bundled export preset catalog validation", () => {
  it.each([
    ["duplicate preset ids", catalog([preset(), preset()]), "preset ids must be unique"],
    ["a non-positive revision", catalog([preset({ presetRevision: 0 })]), "presetRevision"],
    [
      "a default format outside allowedFormats",
      catalog([preset({ allowedFormats: ["jpeg"], defaultFormat: "png" })]),
      "defaultFormat must be allowed",
    ],
    [
      "metadata rules without strip",
      catalog([
        preset({
          metadataPolicies: { jpeg: ["retain-basic"], png: ["strip"] },
        }),
      ]),
      "metadata policies must be unique and include strip",
    ],
    [
      "duplicate post-process rules",
      catalog([preset({ postProcess: ["sharpen", "sharpen"] })]),
      "post-process rules must be non-empty and unique",
    ],
  ])("rejects %s", (_name, declaration, message) => {
    expect(() => buildExportPresetCatalogSnapshot(declaration)).toThrow(message);
  });
});
