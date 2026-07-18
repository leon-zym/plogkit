import type { ImportedAssetId, PlogDocument } from "../../core/document";
import {
  resolveExportPolicy,
  type ExportFormat,
  type ExportPresetId,
  type ResolvedExportPolicy,
  type UnsupportedExportPolicyReason,
} from "../../core/exportPolicy";
import { documentToExportSourceFacts } from "../../render/exportSourceFacts";
import type {
  AssetCatalogSnapshot,
  AssetDescriptor,
  AssetUsage,
} from "../drafts/draftLibrary";
import {
  ExportStagingError,
  type ExportBackendIdentity,
  type ExportOperation,
  type ExportPipelineDependencies,
} from "./types";

export type ExportPhase =
  | "policy"
  | "staging"
  | "assets"
  | "render"
  | "encode"
  | "permission"
  | "destination";

export interface ResolvedExportDiagnostics {
  readonly presetId: ExportPresetId;
  readonly presetRevision: number;
  readonly catalogSchemaVersion: number;
  readonly backend: ExportBackendIdentity;
}

export interface ExportOutputSummary {
  readonly width: number;
  readonly height: number;
  readonly wasReduced: boolean;
  readonly format: ExportFormat;
}

export interface ExportSuccess {
  readonly status: "success";
  readonly assetId: string;
  readonly output: ExportOutputSummary;
  readonly diagnostics: ResolvedExportDiagnostics;
}

export interface ExportCancelled {
  readonly status: "cancelled";
  readonly phase: ExportPhase;
  readonly diagnostics: ResolvedExportDiagnostics;
}

export interface PresetUnavailableFailure {
  readonly status: "failure";
  readonly code: "preset-unavailable";
  readonly phase: "policy";
  readonly diagnostics: {
    readonly requestedPresetId: ExportPresetId;
    readonly catalogSchemaVersion: number;
  };
}

export interface UnsupportedPolicyFailure {
  readonly status: "failure";
  readonly code: "unsupported-policy";
  readonly phase: "policy";
  readonly reason: UnsupportedExportPolicyReason;
  readonly diagnostics: ResolvedExportDiagnostics;
}

export type ResolvedExportFailure =
  | {
      readonly status: "failure";
      readonly code: "staging-failed";
      readonly phase: "staging";
      readonly diagnostics: ResolvedExportDiagnostics;
    }
  | {
      readonly status: "failure";
      readonly code: "asset-unavailable";
      readonly phase: "assets";
      readonly diagnostics: ResolvedExportDiagnostics;
    }
  | {
      readonly status: "failure";
      readonly code: "render-failed";
      readonly phase: "render";
      readonly diagnostics: ResolvedExportDiagnostics;
    }
  | {
      readonly status: "failure";
      readonly code: "encode-failed";
      readonly phase: "encode";
      readonly diagnostics: ResolvedExportDiagnostics;
    }
  | {
      readonly status: "failure";
      readonly code: "permission-denied";
      readonly phase: "permission";
      readonly diagnostics: ResolvedExportDiagnostics;
    }
  | {
      readonly status: "failure";
      readonly code: "destination-failed";
      readonly phase: "destination";
      readonly diagnostics: ResolvedExportDiagnostics;
    };

export type ExportFailure =
  | PresetUnavailableFailure
  | UnsupportedPolicyFailure
  | ResolvedExportFailure;

export type ExportResult = ExportSuccess | ExportCancelled | ExportFailure;

export interface ExportRequest {
  readonly document: PlogDocument;
  readonly assets: AssetCatalogSnapshot;
  readonly signal?: AbortSignal;
}

export interface ExportPipeline {
  readonly run: (request: ExportRequest) => Promise<ExportResult>;
}

function diagnostics(
  policy: ResolvedExportPolicy,
  backend: ExportBackendIdentity,
): ResolvedExportDiagnostics {
  return Object.freeze({
    presetId: policy.presetId,
    presetRevision: policy.presetRevision,
    catalogSchemaVersion: policy.catalogSchemaVersion,
    backend: Object.freeze({ ...backend }),
  });
}

function output(policy: ResolvedExportPolicy): ExportOutputSummary {
  return Object.freeze({
    width: policy.width,
    height: policy.height,
    wasReduced: policy.wasReduced,
    format: policy.format,
  });
}

const ASSET_USAGES: readonly AssetUsage[] = Object.freeze([
  "preview",
  "original",
  "metadata",
]);

function captureAssetCatalog(
  document: PlogDocument,
  assets: AssetCatalogSnapshot,
): AssetCatalogSnapshot {
  const entries = Object.freeze([...assets.entries]);
  const ids = new Set<ImportedAssetId>([
    ...entries,
    ...document.sourceImages.map(({ id }) => id),
  ]);
  const captured = new Map<ImportedAssetId, ReadonlyMap<AssetUsage, AssetDescriptor | null>>();
  for (const assetId of ids) {
    const descriptors = new Map<AssetUsage, AssetDescriptor | null>();
    for (const usage of ASSET_USAGES) {
      const descriptor = assets.resolve(assetId, usage);
      if (
        descriptor !== null &&
        (descriptor.assetId !== assetId || descriptor.usage !== usage)
      ) {
        throw new Error("asset catalog resolver returned a mismatched descriptor");
      }
      descriptors.set(
        usage,
        descriptor === null ? null : Object.freeze({ ...descriptor }),
      );
    }
    captured.set(assetId, descriptors);
  }
  return Object.freeze({
    entries,
    resolve: (assetId: ImportedAssetId, usage: AssetUsage) =>
      captured.get(assetId)?.get(usage) ?? null,
  });
}

async function cleanup(operation: ExportOperation | null): Promise<void> {
  if (operation === null) return;
  try {
    await operation.cleanup();
  } catch {
    // The staging adapter retries orphan cleanup at the next process start.
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** The sole orchestration seam for a real export run. */
export function createExportPipeline({
  backend,
  destination,
  staging,
}: ExportPipelineDependencies): ExportPipeline {
  const run = async ({ document, assets, signal }: ExportRequest): Promise<ExportResult> => {
    const runAssets = captureAssetCatalog(document, assets);
    const backendIdentity = Object.freeze({ ...backend.identity });
    const resolution = resolveExportPolicy(
      document.exportSettings,
      documentToExportSourceFacts(document),
      backend.capabilities,
    );
    if (resolution.status === "failed") {
      if (resolution.error.code === "preset-unavailable") {
        return {
          status: "failure",
          code: "preset-unavailable",
          phase: "policy",
          diagnostics: {
            requestedPresetId: resolution.error.requestedPresetId,
            catalogSchemaVersion: resolution.error.catalogSchemaVersion,
          },
        };
      }
      return {
        status: "failure",
        code: "unsupported-policy",
        phase: "policy",
        reason: resolution.error.reason,
        diagnostics: {
          presetId: resolution.error.presetId,
          presetRevision: resolution.error.presetRevision,
          catalogSchemaVersion: resolution.error.catalogSchemaVersion,
          backend: backendIdentity,
        },
      };
    }

    const policy = resolution.policy;
    const runDiagnostics = diagnostics(policy, backendIdentity);
    if (isAborted(signal)) {
      return { status: "cancelled", phase: "policy", diagnostics: runDiagnostics };
    }

    let operation: ExportOperation | null = null;
    try {
      try {
        operation = await staging.createOperation();
      } catch (error: unknown) {
        if (!(error instanceof ExportStagingError)) throw error;
        return {
          status: "failure",
          code: "staging-failed",
          phase: "staging",
          diagnostics: runDiagnostics,
        };
      }
      if (isAborted(signal)) {
        return { status: "cancelled", phase: "staging", diagnostics: runDiagnostics };
      }

      const backendResult = await backend.prepare({
        document,
        assets: runAssets,
        policy,
        operation,
        signal,
      });
      if (backendResult.status === "cancelled") {
        return { ...backendResult, diagnostics: runDiagnostics };
      }
      if (backendResult.status === "failure") {
        return { ...backendResult, diagnostics: runDiagnostics };
      }
      if (
        backendResult.prepared.operationId !== operation.id ||
        !backendResult.prepared.uri.startsWith(`${operation.directoryUri.replace(/\/$/, "")}/`)
      ) {
        throw new Error("export backend returned a PreparedExport outside its operation");
      }
      if (isAborted(signal)) {
        return { status: "cancelled", phase: "destination", diagnostics: runDiagnostics };
      }

      const destinationResult = await destination.publish(backendResult.prepared, signal);
      if (destinationResult.status === "cancelled") {
        return { ...destinationResult, diagnostics: runDiagnostics };
      }
      if (destinationResult.status === "failure") {
        return { ...destinationResult, diagnostics: runDiagnostics };
      }
      if (destinationResult.assetId.length === 0) {
        throw new Error("Photos destination returned an empty system asset identity");
      }
      return {
        status: "success",
        assetId: destinationResult.assetId,
        output: output(policy),
        diagnostics: runDiagnostics,
      };
    } catch (error: unknown) {
      if (error instanceof ExportStagingError) {
        return {
          status: "failure",
          code: "staging-failed",
          phase: "staging",
          diagnostics: runDiagnostics,
        };
      }
      throw error;
    } finally {
      await cleanup(operation);
    }
  };

  return Object.freeze({ run });
}
