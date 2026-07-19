import type { PlogDocument } from "../../core/document";
import type {
  ExportCapabilities,
  ResolvedExportPolicy,
} from "../../core/exportPolicy";
import type { AssetCatalogSnapshot } from "../drafts/draftLibrary";

export interface ExportBackendIdentity {
  readonly id: string;
  readonly revision: number;
}

export interface PreparedExport {
  readonly kind: "static-image";
  readonly operationId: string;
  readonly uri: string;
  readonly mimeType: ResolvedExportPolicy["mimeType"];
  readonly extension: ResolvedExportPolicy["extension"];
}

export interface PrepareStaticImageInput {
  readonly bytes: Uint8Array;
  readonly mimeType: ResolvedExportPolicy["mimeType"];
  readonly extension: ResolvedExportPolicy["extension"];
}

export interface ExportOperation {
  readonly id: string;
  readonly directoryUri: string;
  readonly prepareStaticImage: (input: PrepareStaticImageInput) => Promise<PreparedExport>;
  readonly cleanup: () => Promise<void>;
}

export interface ExportStaging {
  readonly createOperation: () => Promise<ExportOperation>;
}

export type BackendExportFailure =
  | { readonly status: "failure"; readonly code: "asset-unavailable"; readonly phase: "assets" }
  | { readonly status: "failure"; readonly code: "render-failed"; readonly phase: "render" }
  | { readonly status: "failure"; readonly code: "encode-failed"; readonly phase: "encode" };

export type BackendExportResult =
  | { readonly status: "prepared"; readonly prepared: PreparedExport }
  | {
      readonly status: "cancelled";
      readonly phase: "assets" | "render" | "encode";
    }
  | BackendExportFailure;

export interface ExportBackendInput {
  readonly document: PlogDocument;
  readonly assets: AssetCatalogSnapshot;
  readonly policy: ResolvedExportPolicy;
  readonly operation: ExportOperation;
  readonly signal?: AbortSignal;
}

export interface ExportBackend {
  readonly identity: ExportBackendIdentity;
  readonly capabilities: ExportCapabilities;
  readonly prepare: (input: ExportBackendInput) => Promise<BackendExportResult>;
}

export type PhotosDestinationResult =
  | { readonly status: "published"; readonly assetId: string }
  | { readonly status: "cancelled"; readonly phase: "permission" | "destination" }
  | { readonly status: "failure"; readonly code: "permission-denied"; readonly phase: "permission" }
  | {
      readonly status: "failure";
      readonly code: "destination-failed";
      readonly phase: "destination";
    };

export interface PhotosDestination {
  readonly publish: (
    prepared: PreparedExport,
    signal?: AbortSignal,
  ) => Promise<PhotosDestinationResult>;
}

export interface ExportPipelineDependencies {
  readonly backend: ExportBackend;
  readonly destination: PhotosDestination;
  readonly staging: ExportStaging;
}

export class ExportStagingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExportStagingError";
  }
}
