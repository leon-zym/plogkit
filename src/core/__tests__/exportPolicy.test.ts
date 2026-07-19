import {
  listPresetOptions,
  parseExportSettings,
  resolveExportPolicy,
  type ExportCapabilities,
  type UnsupportedExportPolicyReason,
} from "../exportPolicy";

const fullCapabilities: ExportCapabilities = {
  formats: ["jpeg", "png"],
  metadataPolicies: {
    jpeg: ["strip", "retain-basic"],
    png: ["strip"],
  },
  dynamicRanges: ["sdr"],
  dynamicPhotos: ["still"],
  precompressionModes: ["none", "upload"],
  postProcessRules: [],
};

describe("export policy", () => {
  it("projects immutable preset choices without exposing catalog declarations", () => {
    const options = listPresetOptions();

    expect(options).toEqual([
      {
        id: "original",
        labelKey: "export.presets.original",
        allowedFormats: ["jpeg", "png"],
        defaultFormat: "jpeg",
      },
      {
        id: "social",
        labelKey: "export.presets.social",
        allowedFormats: ["jpeg"],
        defaultFormat: "jpeg",
      },
      {
        id: "compact",
        labelKey: "export.presets.compact",
        allowedFormats: ["jpeg"],
        defaultFormat: "jpeg",
      },
    ]);
    expect(Object.isFrozen(options)).toBe(true);
    expect(options.every((option) => Object.isFrozen(option))).toBe(true);
    expect(options.every((option) => Object.isFrozen(option.allowedFormats))).toBe(true);
  });

  it("parses an opaque preset identity without requiring the current catalog to contain it", () => {
    expect(
      parseExportSettings({
        presetId: "retired-preset",
        metadataPolicy: "retain-basic",
      }),
    ).toEqual({
      presetId: "retired-preset",
      metadataPolicy: "retain-basic",
    });
  });

  it("keeps a structurally valid format override", () => {
    expect(
      parseExportSettings({
        presetId: "original",
        formatOverride: "png",
        metadataPolicy: "strip",
      }),
    ).toEqual({
      presetId: "original",
      formatOverride: "png",
      metadataPolicy: "strip",
    });
  });

  it("rejects the unpublished legacy format field instead of reading it compatibly", () => {
    expect(() =>
      parseExportSettings({
        presetId: "original",
        format: "jpeg",
        metadataPolicy: "strip",
      }),
    ).toThrow("format is not supported");
  });

  it("resolves a complete original policy with catalog diagnostics", () => {
    const settings = parseExportSettings({
      presetId: "original",
      metadataPolicy: "retain-basic",
    });

    expect(
      resolveExportPolicy(settings, { naturalWidth: 4000, naturalHeight: 3000 }, fullCapabilities),
    ).toEqual({
      status: "resolved",
      policy: {
        catalogSchemaVersion: 1,
        presetId: "original",
        presetRevision: 1,
        target: "generic",
        width: 4000,
        height: 3000,
        wasReduced: false,
        format: "jpeg",
        quality: 0.95,
        dynamicRange: "sdr",
        dynamicPhoto: "still",
        precompression: "none",
        metadataPolicy: "retain-basic",
        postProcess: [],
        extension: "jpg",
        mimeType: "image/jpeg",
      },
    });
  });

  it("enforces preset dimensions and global export caps from source facts", () => {
    const social = parseExportSettings({ presetId: "social", metadataPolicy: "strip" });
    const original = parseExportSettings({ presetId: "original", metadataPolicy: "strip" });

    expect(
      resolveExportPolicy(social, { naturalWidth: 4000, naturalHeight: 3000 }, fullCapabilities),
    ).toMatchObject({
      status: "resolved",
      policy: {
        width: 2048,
        height: 1536,
        wasReduced: true,
        precompression: "upload",
      },
    });
    expect(
      resolveExportPolicy(original, { naturalWidth: 6000, naturalHeight: 36000 }, fullCapabilities),
    ).toMatchObject({
      status: "resolved",
      policy: { width: 2730, height: 16384, wasReduced: true },
    });
  });

  it("reports an unavailable preset without inventing a preset revision", () => {
    const settings = parseExportSettings({
      presetId: "retired-preset",
      metadataPolicy: "strip",
    });

    expect(
      resolveExportPolicy(settings, { naturalWidth: 4000, naturalHeight: 3000 }, fullCapabilities),
    ).toEqual({
      status: "failed",
      error: {
        code: "preset-unavailable",
        requestedPresetId: "retired-preset",
        catalogSchemaVersion: 1,
      },
    });
  });

  it("rejects catalog incompatibility and backend capability gaps without degrading", () => {
    const pngWithMetadata = parseExportSettings({
      presetId: "original",
      formatOverride: "png",
      metadataPolicy: "retain-basic",
    });
    const jpeg = parseExportSettings({ presetId: "original", metadataPolicy: "strip" });

    expect(
      resolveExportPolicy(
        pngWithMetadata,
        { naturalWidth: 100, naturalHeight: 100 },
        fullCapabilities,
      ),
    ).toMatchObject({
      status: "failed",
      error: {
        code: "unsupported-policy",
        reason: "metadata-not-allowed",
        presetId: "original",
        presetRevision: 1,
        catalogSchemaVersion: 1,
      },
    });
    expect(
      resolveExportPolicy(
        jpeg,
        { naturalWidth: 100, naturalHeight: 100 },
        {
          ...fullCapabilities,
          formats: ["png"],
        },
      ),
    ).toMatchObject({
      status: "failed",
      error: {
        code: "unsupported-policy",
        reason: "format-unsupported",
        presetId: "original",
        presetRevision: 1,
        catalogSchemaVersion: 1,
      },
    });
  });

  it("diagnoses each currently reachable policy and capability incompatibility", () => {
    const sourceFacts = { naturalWidth: 100, naturalHeight: 100 };
    const original = parseExportSettings({ presetId: "original", metadataPolicy: "strip" });
    const retainBasic = parseExportSettings({
      presetId: "original",
      metadataPolicy: "retain-basic",
    });
    const disallowedPng = parseExportSettings({
      presetId: "social",
      formatOverride: "png",
      metadataPolicy: "strip",
    });
    const social = parseExportSettings({ presetId: "social", metadataPolicy: "strip" });
    const expectReason = (
      settings: Parameters<typeof resolveExportPolicy>[0],
      capabilities: ExportCapabilities,
      reason: UnsupportedExportPolicyReason,
    ) => {
      expect(resolveExportPolicy(settings, sourceFacts, capabilities)).toMatchObject({
        status: "failed",
        error: { code: "unsupported-policy", reason },
      });
    };

    expectReason(disallowedPng, fullCapabilities, "format-not-allowed");
    expectReason(
      retainBasic,
      { ...fullCapabilities, metadataPolicies: { jpeg: ["strip"], png: ["strip"] } },
      "metadata-unsupported",
    );
    expectReason(original, { ...fullCapabilities, dynamicRanges: [] }, "dynamic-range-unsupported");
    expectReason(original, { ...fullCapabilities, dynamicPhotos: [] }, "dynamic-photo-unsupported");
    expectReason(
      social,
      { ...fullCapabilities, precompressionModes: ["none"] },
      "precompression-unsupported",
    );
  });
});
