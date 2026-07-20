import {
  createDocument,
  importedAssetId,
  type PlogDocument,
} from "../../../core/document";
import { parseExportSettings, type ExportCapabilities } from "../../../core/exportPolicy";
import {
  draftId,
  type AssetCatalogSnapshot,
} from "../../drafts/draftLibrary";
import { createExportPipeline } from "../pipeline";
import {
  createExportStaging,
  type ExportStagingFileAdapter,
} from "../staging";
import {
  ExportStagingError,
  type ExportBackend,
  type ExportOperation,
  type ExportStaging,
  type PhotosDestination,
  type PreparedExport,
} from "../types";

const fullCapabilities = Object.freeze({
  formats: Object.freeze(["jpeg", "png"] as const),
  metadataPolicies: Object.freeze({
    jpeg: Object.freeze(["strip", "retain-basic"] as const),
    png: Object.freeze(["strip"] as const),
  }),
  dynamicRanges: Object.freeze(["sdr"] as const),
  dynamicPhotos: Object.freeze(["still"] as const),
  precompressionModes: Object.freeze(["none", "upload"] as const),
  postProcessRules: Object.freeze([]),
}) satisfies ExportCapabilities;

const assets: AssetCatalogSnapshot = Object.freeze({
  entries: Object.freeze([]),
  resolve: () => null,
});

function createSuccessfulHarness(capabilities: ExportCapabilities = fullCapabilities) {
  let operationSequence = 0;
  const operations: ExportOperation[] = [];
  const staging: ExportStaging = {
    createOperation: jest.fn(async (): Promise<ExportOperation> => {
      operationSequence += 1;
      const id = `operation-${operationSequence}`;
      const operation: ExportOperation = {
        id,
        directoryUri: `cache:///exports/${id}`,
        prepareStaticImage: jest.fn(
          async ({ mimeType, extension }): Promise<PreparedExport> => ({
            kind: "static-image",
            operationId: id,
            uri: `cache:///exports/${id}/output.${extension}`,
            mimeType,
            extension,
          }),
        ),
        cleanup: jest.fn(async () => undefined),
      };
      operations.push(operation);
      return operation;
    }),
  };
  const backend: ExportBackend = {
    identity: Object.freeze({ id: "test-static", revision: 7 }),
    capabilities,
    prepare: jest.fn(async ({ operation, policy }) => ({
      status: "prepared" as const,
      prepared: await operation.prepareStaticImage({
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: policy.mimeType,
        extension: policy.extension,
      }),
    })),
  };
  const destination: PhotosDestination = {
    publish: jest.fn(async () => ({ status: "published" as const, assetId: "photos-asset-1" })),
  };
  return {
    pipeline: createExportPipeline({ backend, destination, staging }),
    backend,
    destination,
    staging,
    operations,
  };
}

describe("ExportPipeline.run", () => {
  it("resolves and fixes the current document policy independently for every run", async () => {
    const imageId = importedAssetId("source-1");
    const original = createDocument([{ id: imageId, width: 4000, height: 3000 }]);
    const social: PlogDocument = {
      ...original,
      exportSettings: parseExportSettings({ presetId: "social", metadataPolicy: "strip" }),
    };
    const snapshot: AssetCatalogSnapshot = Object.freeze({
      entries: Object.freeze([imageId]),
      resolve: (candidateId: typeof imageId, usage: "preview" | "original" | "metadata") =>
        candidateId === imageId
          ? Object.freeze({
              draftId: draftId("draft-1"),
              assetId: imageId,
              usage,
              uri: `file:///${usage}.jpg`,
            })
          : null,
    });
    const { pipeline } = createSuccessfulHarness();

    const first = await pipeline.run({ document: original, assets: snapshot });
    const second = await pipeline.run({ document: social, assets: snapshot });

    expect(first).toMatchObject({
      status: "success",
      assetId: "photos-asset-1",
      output: { width: 4000, height: 3000, format: "jpeg", wasReduced: false },
      diagnostics: {
        presetId: "original",
        presetRevision: 1,
        catalogSchemaVersion: 1,
        backend: { id: "test-static", revision: 7 },
      },
    });
    expect(second).toMatchObject({
      status: "success",
      output: { width: 2048, height: 1536, format: "jpeg", wasReduced: true },
      diagnostics: { presetId: "social", presetRevision: 1 },
    });
  });

  it("captures the run-owned asset snapshot before the first await", async () => {
    const imageId = importedAssetId("source-captured");
    const document = createDocument([{ id: imageId, width: 100, height: 100 }]);
    let originalUri = "file:///initial.jpg";
    const dynamicAssets: AssetCatalogSnapshot = Object.freeze({
      entries: Object.freeze([imageId]),
      resolve: (candidateId: typeof imageId, usage: "preview" | "original" | "metadata") =>
        candidateId === imageId
          ? Object.freeze({
              draftId: draftId("draft-captured"),
              assetId: imageId,
              usage,
              uri: usage === "original" ? originalUri : `file:///${usage}`,
            })
          : null,
    });
    const { pipeline, backend, staging } = createSuccessfulHarness();
    const createOperation = staging.createOperation as jest.MockedFunction<
      ExportStaging["createOperation"]
    >;
    const createOperationImplementation = createOperation.getMockImplementation();
    if (createOperationImplementation === undefined) throw new Error("missing test operation");
    let releaseOperation: (() => void) | undefined;
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    createOperation.mockImplementationOnce(async () => {
      await operationGate;
      return createOperationImplementation();
    });

    const exporting = pipeline.run({ document, assets: dynamicAssets });
    originalUri = "file:///changed.jpg";
    releaseOperation?.();
    await exporting;

    const input = (backend.prepare as jest.Mock).mock.calls[0]?.[0];
    expect(input.assets.resolve(imageId, "original")?.uri).toBe("file:///initial.jpg");
  });

  it("returns preset-unavailable without inventing preset or backend revisions", async () => {
    const document: PlogDocument = {
      ...createDocument(),
      exportSettings: parseExportSettings({ presetId: "retired", metadataPolicy: "strip" }),
    };
    const { pipeline } = createSuccessfulHarness();

    const result = await pipeline.run({ document, assets });

    expect(result).toEqual({
      status: "failure",
      code: "preset-unavailable",
      phase: "policy",
      diagnostics: { requestedPresetId: "retired", catalogSchemaVersion: 1 },
    });
    expect(result).not.toHaveProperty("diagnostics.presetRevision");
    expect(result).not.toHaveProperty("diagnostics.backend");
  });

  it("returns unsupported-policy with actual preset, catalog, and backend diagnostics", async () => {
    const unsupportedCapabilities: ExportCapabilities = Object.freeze({
      ...fullCapabilities,
      formats: Object.freeze([]),
    });
    const { pipeline } = createSuccessfulHarness(unsupportedCapabilities);

    const result = await pipeline.run({ document: createDocument(), assets });

    expect(result).toEqual({
      status: "failure",
      code: "unsupported-policy",
      phase: "policy",
      reason: "format-unsupported",
      diagnostics: {
        presetId: "original",
        presetRevision: 1,
        catalogSchemaVersion: 1,
        backend: { id: "test-static", revision: 7 },
      },
    });
  });

  it("sweeps crash orphans and removes the PreparedExport after Photos publication", async () => {
    const directories = new Set(["cache:///export-staging/orphan"]);
    const files = new Map<string, Uint8Array>();
    const adapter: ExportStagingFileAdapter = {
      ensureDirectory: async (uri) => {
        directories.add(uri);
      },
      createDirectory: async (uri) => {
        if (directories.has(uri)) throw new Error("directory exists");
        directories.add(uri);
      },
      listDirectories: async (uri) =>
        [...directories].filter((candidate) => candidate.startsWith(`${uri}/`)),
      writeBytes: async (uri, bytes) => {
        files.set(uri, bytes);
      },
      removeDirectory: async (uri) => {
        directories.delete(uri);
        for (const file of files.keys()) {
          if (file.startsWith(`${uri}/`)) files.delete(file);
        }
      },
    };
    const staging = createExportStaging({
      files: adapter,
      rootUri: "cache:///export-staging",
      createOperationId: () => "current",
    });
    const { backend, destination } = createSuccessfulHarness();
    const pipeline = createExportPipeline({ backend, destination, staging });

    const result = await pipeline.run({ document: createDocument(), assets });

    expect(result.status).toBe("success");
    expect([...directories]).toEqual(["cache:///export-staging"]);
    expect(files.size).toBe(0);
  });

  it("sweeps crash orphans during app startup before any export operation", async () => {
    const directories = new Set([
      "cache:///export-staging",
      "cache:///export-staging/orphan",
    ]);
    const adapter: ExportStagingFileAdapter = {
      ensureDirectory: async (uri) => {
        directories.add(uri);
      },
      createDirectory: async (uri) => {
        directories.add(uri);
      },
      listDirectories: async (uri) =>
        [...directories].filter((candidate) => candidate.startsWith(`${uri}/`)),
      writeBytes: async () => undefined,
      removeDirectory: async (uri) => {
        directories.delete(uri);
      },
    };
    const staging = createExportStaging({
      files: adapter,
      rootUri: "cache:///export-staging",
    });

    await staging.initialize();

    expect([...directories]).toEqual(["cache:///export-staging"]);
  });

  it("retries required staging initialization after a transient failure", async () => {
    const directories = new Set<string>();
    let ensureAttempts = 0;
    const staging = createExportStaging({
      rootUri: "cache:///export-staging",
      createOperationId: () => "recovered",
      files: {
        ensureDirectory: async (uri) => {
          ensureAttempts += 1;
          if (ensureAttempts === 1) throw new Error("cache temporarily unavailable");
          directories.add(uri);
        },
        createDirectory: async (uri) => {
          directories.add(uri);
        },
        listDirectories: async () => [],
        writeBytes: async () => undefined,
        removeDirectory: async (uri) => {
          directories.delete(uri);
        },
      },
    });

    await expect(staging.initialize()).rejects.toThrow("export staging could not be initialized");
    await expect(staging.initialize()).resolves.toBeUndefined();
    const operation = await staging.createOperation();
    expect(operation.directoryUri).toBe("cache:///export-staging/recovered");
  });

  it("does not let orphan enumeration failure block a new export operation", async () => {
    const directories = new Set<string>();
    const staging = createExportStaging({
      rootUri: "cache:///export-staging",
      createOperationId: () => "current",
      files: {
        ensureDirectory: async (uri) => {
          directories.add(uri);
        },
        createDirectory: async (uri) => {
          directories.add(uri);
        },
        listDirectories: async () => {
          throw new Error("enumeration unavailable");
        },
        writeBytes: async () => undefined,
        removeDirectory: async (uri) => {
          directories.delete(uri);
        },
      },
    });

    const operation = await staging.createOperation();

    expect(operation.directoryUri).toBe("cache:///export-staging/current");
    expect(directories.has(operation.directoryUri)).toBe(true);
  });

  it("does not sweep an active operation when enumeration normalizes its directory URI", async () => {
    const root = "cache:///export-staging";
    const operationUri = `${root}/current`;
    const directories = new Set<string>();
    const staging = createExportStaging({
      rootUri: root,
      createOperationId: () => "current",
      files: {
        ensureDirectory: async (uri) => {
          directories.add(uri);
        },
        createDirectory: async (uri) => {
          directories.add(`${uri}/`);
        },
        listDirectories: async () =>
          [...directories].filter((uri) => uri.replace(/\/$/, "") !== root),
        writeBytes: async () => undefined,
        removeDirectory: async (uri) => {
          directories.delete(uri);
        },
      },
    });
    await staging.createOperation();

    await staging.initialize();

    expect(directories.has(`${operationUri}/`)).toBe(true);
  });

  it.each([
    ["asset-unavailable", "assets"],
    ["render-failed", "render"],
    ["encode-failed", "encode"],
  ] as const)("returns backend failure %s and cleans its operation", async (code, phase) => {
    const { pipeline, backend, operations } = createSuccessfulHarness();
    (backend.prepare as jest.Mock).mockResolvedValueOnce({ status: "failure", code, phase });

    await expect(pipeline.run({ document: createDocument(), assets })).resolves.toMatchObject({
      status: "failure",
      code,
      phase,
      diagnostics: { backend: { id: "test-static", revision: 7 } },
    });
    expect(operations[0]?.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["assets"],
    ["render"],
    ["encode"],
  ] as const)("returns backend cancellation in %s and cleans its operation", async (phase) => {
    const { pipeline, backend, operations } = createSuccessfulHarness();
    (backend.prepare as jest.Mock).mockResolvedValueOnce({ status: "cancelled", phase });

    await expect(pipeline.run({ document: createDocument(), assets })).resolves.toMatchObject({
      status: "cancelled",
      phase,
    });
    expect(operations[0]?.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["permission-denied", "permission"],
    ["destination-failed", "destination"],
  ] as const)("returns destination failure %s and cleans its operation", async (code, phase) => {
    const { pipeline, destination, operations } = createSuccessfulHarness();
    (destination.publish as jest.Mock).mockResolvedValueOnce({ status: "failure", code, phase });

    await expect(pipeline.run({ document: createDocument(), assets })).resolves.toMatchObject({
      status: "failure",
      code,
      phase,
    });
    expect(operations[0]?.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each(["permission", "destination"] as const)(
    "returns destination cancellation in %s and cleans its operation",
    async (phase) => {
      const { pipeline, destination, operations } = createSuccessfulHarness();
      (destination.publish as jest.Mock).mockResolvedValueOnce({ status: "cancelled", phase });

      await expect(pipeline.run({ document: createDocument(), assets })).resolves.toMatchObject({
        status: "cancelled",
        phase,
      });
      expect(operations[0]?.cleanup).toHaveBeenCalledTimes(1);
    },
  );

  it("returns a typed staging failure when an operation cannot be created", async () => {
    const { backend, destination } = createSuccessfulHarness();
    const pipeline = createExportPipeline({
      backend,
      destination,
      staging: {
        createOperation: async () => {
          throw new ExportStagingError("cache unavailable");
        },
      },
    });

    await expect(pipeline.run({ document: createDocument(), assets })).resolves.toMatchObject({
      status: "failure",
      code: "staging-failed",
      phase: "staging",
    });
  });

  it("returns a typed staging failure and cleans when PreparedExport cannot be written", async () => {
    const { backend, destination } = createSuccessfulHarness();
    const operation: ExportOperation = {
      id: "operation-write-failure",
      directoryUri: "cache:///exports/operation-write-failure",
      prepareStaticImage: async () => {
        throw new ExportStagingError("cache write failed");
      },
      cleanup: jest.fn(async () => undefined),
    };
    const pipeline = createExportPipeline({
      backend,
      destination,
      staging: { createOperation: async () => operation },
    });

    await expect(pipeline.run({ document: createDocument(), assets })).resolves.toMatchObject({
      status: "failure",
      code: "staging-failed",
      phase: "staging",
    });
    expect(operation.cleanup).toHaveBeenCalledTimes(1);
  });

  it("returns staging cancellation and cleans an allocated operation", async () => {
    const controller = new AbortController();
    const { backend, destination } = createSuccessfulHarness();
    const operation: ExportOperation = {
      id: "operation-cancelled",
      directoryUri: "cache:///exports/operation-cancelled",
      prepareStaticImage: jest.fn(),
      cleanup: jest.fn(async () => undefined),
    };
    const pipeline = createExportPipeline({
      backend,
      destination,
      staging: {
        createOperation: async () => {
          controller.abort();
          return operation;
        },
      },
    });

    await expect(
      pipeline.run({ document: createDocument(), assets, signal: controller.signal }),
    ).resolves.toMatchObject({ status: "cancelled", phase: "staging" });
    expect(backend.prepare).not.toHaveBeenCalled();
    expect(operation.cleanup).toHaveBeenCalledTimes(1);
  });

  it("cleans its operation before rethrowing a programming error", async () => {
    const { pipeline, backend, operations } = createSuccessfulHarness();
    (backend.prepare as jest.Mock).mockRejectedValueOnce(new Error("backend contract bug"));

    await expect(pipeline.run({ document: createDocument(), assets })).rejects.toThrow(
      "backend contract bug",
    );
    expect(operations[0]?.cleanup).toHaveBeenCalledTimes(1);
  });

  it("preserves the primary success when cleanup fails", async () => {
    const { pipeline, staging } = createSuccessfulHarness();
    const createOperation = staging.createOperation as jest.MockedFunction<
      ExportStaging["createOperation"]
    >;
    const implementation = createOperation.getMockImplementation();
    if (implementation === undefined) throw new Error("missing test operation");
    createOperation.mockImplementationOnce(async () => {
      const operation = await implementation();
      return { ...operation, cleanup: async () => Promise.reject(new Error("cleanup failed")) };
    });

    await expect(pipeline.run({ document: createDocument(), assets })).resolves.toMatchObject({
      status: "success",
      assetId: "photos-asset-1",
    });
  });

  it("rejects a PreparedExport outside its operation after cleanup", async () => {
    const { pipeline, backend, operations } = createSuccessfulHarness();
    (backend.prepare as jest.Mock).mockResolvedValueOnce({
      status: "prepared",
      prepared: {
        kind: "static-image",
        operationId: "another-operation",
        uri: "cache:///exports/another-operation/output.jpg",
        mimeType: "image/jpeg",
        extension: "jpg",
      },
    });

    await expect(pipeline.run({ document: createDocument(), assets })).rejects.toThrow(
      "outside its operation",
    );
    expect(operations[0]?.cleanup).toHaveBeenCalledTimes(1);
  });

  it("returns policy cancellation without creating staging", async () => {
    const controller = new AbortController();
    controller.abort();
    const { pipeline, staging } = createSuccessfulHarness();

    await expect(
      pipeline.run({ document: createDocument(), assets, signal: controller.signal }),
    ).resolves.toMatchObject({ status: "cancelled", phase: "policy" });
    expect(staging.createOperation).not.toHaveBeenCalled();
  });
});
