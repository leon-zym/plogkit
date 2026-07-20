import {
  createDocument,
  importedAssetId,
  parseDocumentJson,
  type ImportedAssetId,
  type PlogDocument,
  type SourceImage,
} from "@/core/document";
import type { MetadataPolicy } from "@/core/exportPolicy";
import { extractImageMetadata, type ImageMetadataSidecar } from "@/services/image-import/metadata";
import {
  commitPreparedFile,
  recoverFile,
  type RecoverableFileState,
} from "@/services/persistence/recoverableFile";

export type ImportCandidateKind = "image" | "livePhoto" | "unsupported";

export interface ImportCandidate {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
  readonly fileName?: string | null;
  readonly kind: ImportCandidateKind;
  readonly exif?: unknown;
  readonly pairedVideoUri?: string | null;
}

declare const draftIdBrand: unique symbol;
export type DraftId = string & { readonly [draftIdBrand]: true };

export function draftId(value: string): DraftId {
  if (value.length === 0) throw new Error("DraftId must be a non-empty opaque identity");
  return value as DraftId;
}

export interface DraftLibraryFileAdapter {
  readonly fileExists: (uri: string) => Promise<boolean>;
  readonly directoryExists: (uri: string) => Promise<boolean>;
  readonly ensureDirectory: (uri: string) => Promise<void>;
  readonly readText: (uri: string) => Promise<string>;
  readonly writeText: (uri: string, content: string) => Promise<void>;
  readonly copy: (sourceUri: string, destinationUri: string) => Promise<void>;
  readonly moveFile: (sourceUri: string, destinationUri: string) => Promise<void>;
  readonly moveDirectory: (sourceUri: string, destinationUri: string) => Promise<void>;
  readonly removeFile: (uri: string) => Promise<void>;
  readonly removeDirectory: (uri: string) => Promise<void>;
  readonly listDirectories: (uri: string) => Promise<readonly string[]>;
  readonly listFiles: (uri: string) => Promise<readonly string[]>;
}

export interface DraftLibraryPreviewAdapter {
  readonly generate: (
    sourceUri: string,
    destinationUri: string,
    maxLongEdge: number,
  ) => Promise<{ readonly width: number; readonly height: number }>;
  readonly isValid: (uri: string) => Promise<boolean>;
}

export type AssetUsage = "preview" | "original" | "metadata";

export interface AssetDescriptor {
  readonly draftId: DraftId;
  readonly assetId: ImportedAssetId;
  readonly usage: AssetUsage;
  readonly uri: string;
}

export interface AssetCatalogSnapshot {
  readonly entries: readonly ImportedAssetId[];
  readonly resolve: (assetId: ImportedAssetId, usage: AssetUsage) => AssetDescriptor | null;
}

export interface DraftImportError {
  readonly index: number;
  readonly sourceUri: string;
  readonly message: string;
}

export type CreateDraftResult =
  | {
      readonly status: "created";
      readonly draftId: DraftId;
      readonly document: PlogDocument;
      readonly assets: AssetCatalogSnapshot;
      readonly errors: readonly DraftImportError[];
    }
  | { readonly status: "not-created"; readonly errors: readonly DraftImportError[] }
  | {
      readonly status: "create-failed";
      readonly message: string;
      readonly errors: readonly DraftImportError[];
    };

export type DraftRecoveryFailure =
  | "draft-not-found"
  | "document-corrupt"
  | "catalog-corrupt"
  | "asset-reference-missing"
  | "asset-facts-mismatch"
  | "original-missing"
  | "storage-unavailable";

export type ReadDraftResult =
  | {
      readonly status: "ready";
      readonly draftId: DraftId;
      readonly document: PlogDocument;
      readonly assets: AssetCatalogSnapshot;
    }
  | { readonly status: "recovery-failed"; readonly reason: DraftRecoveryFailure };

export type SaveDraftResult =
  | { readonly status: "saved"; readonly document: PlogDocument }
  | {
      readonly status: "save-failed";
      readonly reason: DraftRecoveryFailure | "storage-failed";
      readonly message?: string;
    };

export interface IngestedAsset {
  readonly image: SourceImage;
  readonly sourceKind: Exclude<ImportCandidateKind, "unsupported">;
}

export interface IngestAssetsResult {
  readonly status: "ingested" | "ingest-failed";
  readonly imported: readonly IngestedAsset[];
  readonly errors: readonly DraftImportError[];
  readonly assets?: AssetCatalogSnapshot;
  readonly message?: string;
}

export type ReadPreviewResult =
  | {
      readonly status: "ready";
      readonly descriptor: AssetDescriptor;
      readonly assets: AssetCatalogSnapshot;
    }
  | {
      readonly status: "preview-failed";
      readonly reason: DraftRecoveryFailure | "preview-unavailable";
      readonly message?: string;
    };

export interface DraftLibrary {
  readonly create: (
    candidates: readonly ImportCandidate[],
    options: { readonly metadataPolicy: MetadataPolicy },
  ) => Promise<CreateDraftResult>;
  /** Pre-open aggregate read. Active/idempotent session access must retain its existing snapshot. */
  readonly read: (id: DraftId) => Promise<ReadDraftResult>;
  readonly save: (id: DraftId, document: PlogDocument) => Promise<SaveDraftResult>;
  readonly ingest: (
    id: DraftId,
    candidates: readonly ImportCandidate[],
  ) => Promise<IngestAssetsResult>;
  readonly readPreview: (id: DraftId, assetId: ImportedAssetId) => Promise<ReadPreviewResult>;
  /** Best-effort compaction and orphan cleanup. Caller must guarantee the Draft is inactive. */
  readonly maintainInactive: (id: DraftId) => Promise<void>;
}

interface CatalogEntry {
  readonly id: ImportedAssetId;
  readonly storageKey: string;
  readonly originalExtension: string;
  readonly width: number;
  readonly height: number;
  readonly previewWidth: number;
  readonly previewHeight: number;
  readonly metadata: boolean;
  readonly sourceKind: Exclude<ImportCandidateKind, "unsupported">;
}

interface Catalog {
  readonly catalogSchemaVersion: 1;
  readonly entries: readonly CatalogEntry[];
}

interface ImportedStagedAsset {
  readonly entry: CatalogEntry;
  readonly image: SourceImage;
}

type ValidatedAggregate =
  | {
      readonly status: "valid";
      readonly uri: string;
      readonly document: PlogDocument;
      readonly catalog: Catalog;
    }
  | { readonly status: "invalid"; readonly reason: DraftRecoveryFailure };

export interface CreateDraftLibraryOptions {
  readonly files: DraftLibraryFileAdapter;
  readonly previews: DraftLibraryPreviewAdapter;
  readonly rootUri: string;
  readonly createDraftId?: () => DraftId;
  readonly createAssetId?: (candidate: ImportCandidate, index: number) => ImportedAssetId;
  readonly createStorageKey?: () => string;
  readonly createOperationId?: () => string;
}

let identitySequence = 0;

function nextIdentity(prefix: string): string {
  identitySequence += 1;
  return `${prefix}-${Date.now()}-${identitySequence}`;
}

function defaultDraftId(): DraftId {
  return draftId(nextIdentity("draft"));
}

function defaultAssetId(): ImportedAssetId {
  return importedAssetId(nextIdentity("asset"));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function child(parent: string, name: string): string {
  return `${parent.replace(/\/$/, "")}/${name}`;
}

function normalizedDirectoryUri(uri: string): string {
  return uri.replace(/\/$/, "");
}

function isDirectChild(parent: string, candidate: string): boolean {
  const prefix = `${parent.replace(/\/$/, "")}/`;
  if (!candidate.startsWith(prefix)) return false;
  const relative = candidate.slice(prefix.length);
  return relative.length > 0 && !relative.includes("/");
}

function storageDraftName(id: DraftId): string {
  const bytes = new Uint8Array(id.length * 2);
  for (let index = 0; index < id.length; index += 1) {
    const codeUnit = id.charCodeAt(index);
    bytes[index * 2] = codeUnit >>> 8;
    bytes[index * 2 + 1] = codeUnit & 0xff;
  }

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = index + 1 < bytes.length ? bytes[index + 1]! : undefined;
    const third = index + 2 < bytes.length ? bytes[index + 2]! : undefined;
    encoded += alphabet[first >>> 2];
    encoded += alphabet[((first & 0x03) << 4) | ((second ?? 0) >>> 4)];
    if (second !== undefined) {
      encoded += alphabet[((second & 0x0f) << 2) | ((third ?? 0) >>> 6)];
    }
    if (third !== undefined) encoded += alphabet[third & 0x3f];
  }
  return `draft-${encoded}`;
}

function originalExtension(candidate: ImportCandidate): string {
  const source = candidate.fileName ?? candidate.uri.split(/[?#]/, 1)[0] ?? "";
  const match = /\.([a-zA-Z0-9]{1,10})$/.exec(source);
  return match?.[1]?.toLowerCase() ?? "jpg";
}

function assertStorageKey(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error("storage key must be path-safe");
  }
  return value;
}

function parseCatalog(json: string): Catalog {
  const input: unknown = JSON.parse(json);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("catalog must be an object");
  }
  const record = input as Record<string, unknown>;
  if (record.catalogSchemaVersion !== 1 || !Array.isArray(record.entries)) {
    throw new Error("catalog schema is invalid");
  }
  const entries = record.entries.map((value, index): CatalogEntry => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`catalog entry ${index} is invalid`);
    }
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      typeof entry.storageKey !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(entry.storageKey) ||
      typeof entry.originalExtension !== "string" ||
      !/^[a-zA-Z0-9]{1,10}$/.test(entry.originalExtension) ||
      typeof entry.width !== "number" ||
      !Number.isInteger(entry.width) ||
      entry.width <= 0 ||
      typeof entry.height !== "number" ||
      !Number.isInteger(entry.height) ||
      entry.height <= 0 ||
      typeof entry.previewWidth !== "number" ||
      !Number.isInteger(entry.previewWidth) ||
      entry.previewWidth <= 0 ||
      typeof entry.previewHeight !== "number" ||
      !Number.isInteger(entry.previewHeight) ||
      entry.previewHeight <= 0 ||
      typeof entry.metadata !== "boolean" ||
      (entry.sourceKind !== "image" && entry.sourceKind !== "livePhoto")
    ) {
      throw new Error(`catalog entry ${index} is invalid`);
    }
    return Object.freeze({
      id: importedAssetId(entry.id),
      storageKey: entry.storageKey,
      originalExtension: entry.originalExtension,
      width: entry.width,
      height: entry.height,
      previewWidth: entry.previewWidth,
      previewHeight: entry.previewHeight,
      metadata: entry.metadata,
      sourceKind: entry.sourceKind,
    });
  });
  if (new Set(entries.map(({ id }) => id)).size !== entries.length) {
    throw new Error("catalog asset identities must be unique");
  }
  if (new Set(entries.map(({ storageKey }) => storageKey)).size !== entries.length) {
    throw new Error("catalog storage keys must be unique");
  }
  return Object.freeze({ catalogSchemaVersion: 1, entries: Object.freeze(entries) });
}

function catalogJson(entries: readonly CatalogEntry[]): string {
  return JSON.stringify({ catalogSchemaVersion: 1, entries });
}

function textFileState(
  files: DraftLibraryFileAdapter,
  currentUri: string,
  parse: (text: string) => unknown,
): RecoverableFileState {
  return {
    currentUri,
    backupUri: `${currentUri}.backup`,
    temporaryUri: `${currentUri}.tmp`,
    isValid: async (uri) => {
      if (!(await files.fileExists(uri))) return false;
      const text = await files.readText(uri);
      try {
        parse(text);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function descriptorUri(draftUri: string, entry: CatalogEntry, usage: AssetUsage): string | null {
  if (usage === "original") {
    return child(child(draftUri, "assets"), `${entry.storageKey}.${entry.originalExtension}`);
  }
  if (usage === "preview") {
    return child(child(draftUri, "previews"), `${entry.storageKey}.jpg`);
  }
  return entry.metadata
    ? child(child(draftUri, "metadata"), `${entry.storageKey}.json`)
    : null;
}

function createCatalogSnapshot(
  id: DraftId,
  draftUri: string,
  catalog: Catalog,
): AssetCatalogSnapshot {
  const byId = new Map(catalog.entries.map((entry) => [entry.id, entry]));
  const entries = Object.freeze(catalog.entries.map(({ id: assetId }) => assetId));
  return Object.freeze({
    entries,
    resolve: (assetId: ImportedAssetId, usage: AssetUsage) => {
      const entry = byId.get(assetId);
      if (entry === undefined) return null;
      const uri = descriptorUri(draftUri, entry, usage);
      return uri === null
        ? null
        : Object.freeze({ draftId: id, assetId, usage, uri });
    },
  });
}

function sourceImage(entry: CatalogEntry): SourceImage {
  return Object.freeze({ id: entry.id, width: entry.width, height: entry.height });
}

export function createDraftLibrary({
  files,
  previews,
  rootUri,
  createDraftId = defaultDraftId,
  createAssetId = defaultAssetId,
  createStorageKey = () => nextIdentity("file"),
  createOperationId = () => nextIdentity("operation"),
}: CreateDraftLibraryOptions): DraftLibrary {
  const draftsUri = child(rootUri, "drafts");
  const stagingUri = child(rootUri, "staging");
  let initializePromise: Promise<void> | null = null;
  const activeStagingOperations = new Set<string>();
  const draftOperationTails = new Map<DraftId, Promise<void>>();

  const serializeDraftOperation = <T>(id: DraftId, operation: () => Promise<T>): Promise<T> => {
    const previous = draftOperationTails.get(id) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    draftOperationTails.set(id, tail);
    void tail.finally(() => {
      if (draftOperationTails.get(id) === tail) draftOperationTails.delete(id);
    });
    return result;
  };

  const safeRemoveFile = async (uri: string): Promise<void> => {
    try {
      await files.removeFile(uri);
    } catch {
      // Orphan cleanup is retryable maintenance and must not replace the transaction result.
    }
  };

  const safeRemoveDirectory = async (uri: string): Promise<void> => {
    try {
      await files.removeDirectory(uri);
    } catch {
      // Crash staging cleanup is best effort and retried by a later library instance.
    }
  };

  const originalFileExists = async (uri: string): Promise<boolean> => {
    try {
      return await files.fileExists(uri);
    } catch {
      return false;
    }
  };

  const initialize = (): Promise<void> => {
    initializePromise ??= (async () => {
      try {
        await files.ensureDirectory(rootUri);
        await files.ensureDirectory(draftsUri);
        await files.ensureDirectory(stagingUri);
      } catch (error: unknown) {
        initializePromise = null;
        throw error;
      }
    })();
    return initializePromise;
  };

  const maintainStaging = async (): Promise<void> => {
    let residuals: readonly string[];
    try {
      residuals = await files.listDirectories(stagingUri);
    } catch {
      return;
    }
    for (const residual of residuals) {
      if (!activeStagingOperations.has(normalizedDirectoryUri(residual))) {
        await safeRemoveDirectory(residual);
      }
    }
  };

  const finishStagingOperation = async (operationUri: string): Promise<void> => {
    try {
      await safeRemoveDirectory(operationUri);
    } finally {
      activeStagingOperations.delete(normalizedDirectoryUri(operationUri));
    }
  };

  const draftUri = (id: DraftId): string => child(draftsUri, storageDraftName(id));

  const stageCandidate = async (
    operationUri: string,
    candidate: ImportCandidate,
    index: number,
    usedIds: Set<ImportedAssetId>,
    usedStorageKeys: Set<string>,
  ): Promise<ImportedStagedAsset> => {
    if (candidate.kind === "unsupported") throw new Error("unsupported media type");
    if (
      !Number.isInteger(candidate.width) ||
      !Number.isInteger(candidate.height) ||
      candidate.width <= 0 ||
      candidate.height <= 0
    ) {
      throw new Error("image dimensions must be positive integers");
    }
    const id = createAssetId(candidate, index);
    if (usedIds.has(id)) throw new Error("asset identity must be unique within the Draft");
    const storageKey = assertStorageKey(createStorageKey());
    if (usedStorageKeys.has(storageKey)) throw new Error("storage key must be unique");
    const extension = originalExtension(candidate);
    const originalUri = child(child(operationUri, "assets"), `${storageKey}.${extension}`);
    const previewUri = child(child(operationUri, "previews"), `${storageKey}.jpg`);
    const metadataUri = child(child(operationUri, "metadata"), `${storageKey}.json`);
    await files.copy(candidate.uri, originalUri);
    const previewSize = await previews.generate(originalUri, previewUri, 2048);
    if (
      !Number.isInteger(previewSize.width) ||
      !Number.isInteger(previewSize.height) ||
      previewSize.width <= 0 ||
      previewSize.height <= 0 ||
      Math.max(previewSize.width, previewSize.height) > 2048
    ) {
      throw new Error("preview dimensions exceed the 2048px limit");
    }
    const metadata: ImageMetadataSidecar | null = extractImageMetadata(candidate.exif);
    if (metadata !== null) await files.writeText(metadataUri, JSON.stringify(metadata));
    const entry: CatalogEntry = Object.freeze({
      id,
      storageKey,
      originalExtension: extension,
      width: candidate.width,
      height: candidate.height,
      previewWidth: previewSize.width,
      previewHeight: previewSize.height,
      metadata: metadata !== null,
      sourceKind: candidate.kind,
    });
    return { entry, image: sourceImage(entry) };
  };

  const validateAggregate = async (id: DraftId): Promise<ValidatedAggregate> => {
    const uri = draftUri(id);
    const documentUri = child(uri, "document.json");
    const catalogUri = child(uri, "catalog.json");
    try {
      if (!(await files.directoryExists(uri))) {
        return { status: "invalid", reason: "draft-not-found" };
      }
    } catch {
      return { status: "invalid", reason: "draft-not-found" };
    }
    try {
      await recoverFile(files, textFileState(files, documentUri, parseDocumentJson));
      if (!(await files.fileExists(documentUri))) {
        return { status: "invalid", reason: "document-corrupt" };
      }
    } catch {
      return { status: "invalid", reason: "document-corrupt" };
    }
    try {
      await recoverFile(files, textFileState(files, catalogUri, parseCatalog));
      if (!(await files.fileExists(catalogUri))) {
        return { status: "invalid", reason: "catalog-corrupt" };
      }
    } catch {
      return { status: "invalid", reason: "catalog-corrupt" };
    }
    let document: PlogDocument;
    try {
      document = parseDocumentJson(await files.readText(documentUri));
    } catch {
      return { status: "invalid", reason: "document-corrupt" };
    }
    let catalog: Catalog;
    try {
      catalog = parseCatalog(await files.readText(catalogUri));
    } catch {
      return { status: "invalid", reason: "catalog-corrupt" };
    }
    const byId = new Map(catalog.entries.map((entry) => [entry.id, entry]));
    for (const image of document.sourceImages) {
      const entry = byId.get(image.id);
      if (entry === undefined) {
        return { status: "invalid", reason: "asset-reference-missing" };
      }
      if (entry.width !== image.width || entry.height !== image.height) {
        return { status: "invalid", reason: "asset-facts-mismatch" };
      }
      const originalUri = descriptorUri(uri, entry, "original");
      if (originalUri === null || !(await originalFileExists(originalUri))) {
        return { status: "invalid", reason: "original-missing" };
      }
    }
    return {
      status: "valid",
      uri,
      document,
      catalog,
    };
  };

  const load = async (id: DraftId): Promise<ReadDraftResult> => {
    try {
      await initialize();
    } catch {
      return { status: "recovery-failed", reason: "storage-unavailable" };
    }
    await maintainStaging();
    const validated = await validateAggregate(id);
    if (validated.status === "invalid") {
      return { status: "recovery-failed", reason: validated.reason };
    }
    return {
      status: "ready",
      draftId: id,
      document: validated.document,
      assets: createCatalogSnapshot(id, validated.uri, validated.catalog),
    };
  };

  const maintainInactiveUnserialized = async (id: DraftId): Promise<void> => {
    try {
      await initialize();
    } catch {
      return;
    }
    await maintainStaging();
    const validated = await validateAggregate(id);
    if (validated.status === "invalid") return;
    const { uri, document, catalog } = validated;
    const catalogUri = child(uri, "catalog.json");
    const catalogState = textFileState(files, catalogUri, parseCatalog);
    const live = new Set(document.sourceImages.map(({ id: assetId }) => assetId));
    const stale = catalog.entries.filter(({ id: assetId }) => !live.has(assetId));
    const retained = catalog.entries.filter(({ id: assetId }) => live.has(assetId));
    if (stale.length > 0) {
      try {
        const nextCatalogJson = catalogJson(retained);
        await recoverFile(files, catalogState);
        await files.writeText(catalogState.temporaryUri, nextCatalogJson);
        await commitPreparedFile(
          files,
          catalogState,
          async (currentUri) => (await files.readText(currentUri)) === nextCatalogJson,
        );
      } catch {
        return;
      }
    }

    const retainedCatalog = parseCatalog(catalogJson(retained));
    for (const [directoryName, usage] of [
      ["assets", "original"],
      ["previews", "preview"],
      ["metadata", "metadata"],
    ] as const) {
      const directoryUri = child(uri, directoryName);
      const reachable = new Set(
        retainedCatalog.entries
          .map((entry) => descriptorUri(uri, entry, usage))
          .filter((candidate): candidate is string => candidate !== null),
      );
      let candidates: readonly string[];
      try {
        candidates = await files.listFiles(directoryUri);
      } catch {
        continue;
      }
      for (const candidate of candidates) {
        if (isDirectChild(directoryUri, candidate) && !reachable.has(candidate)) {
          await safeRemoveFile(candidate);
        }
      }
    }
  };

  const readUnserialized = async (id: DraftId): Promise<ReadDraftResult> => {
    try {
      await initialize();
    } catch {
      return { status: "recovery-failed", reason: "storage-unavailable" };
    }
    return load(id);
  };

  const create = async (
    candidates: readonly ImportCandidate[],
    options: { readonly metadataPolicy: MetadataPolicy },
  ): Promise<CreateDraftResult> => {
    if (candidates.length === 0) return { status: "not-created", errors: [] };
    try {
      await initialize();
    } catch (error: unknown) {
      return { status: "create-failed", message: errorMessage(error), errors: [] };
    }
    await maintainStaging();
    const operationUri = child(stagingUri, assertStorageKey(createOperationId()));
    activeStagingOperations.add(normalizedDirectoryUri(operationUri));
    const itemsUri = child(operationUri, "items");
    const aggregateUri = child(operationUri, "aggregate");
    try {
      await files.ensureDirectory(operationUri);
      await files.ensureDirectory(itemsUri);
      await files.ensureDirectory(aggregateUri);
      await files.ensureDirectory(child(aggregateUri, "assets"));
      await files.ensureDirectory(child(aggregateUri, "previews"));
      await files.ensureDirectory(child(aggregateUri, "metadata"));
    } catch (error: unknown) {
      await finishStagingOperation(operationUri);
      return { status: "create-failed", message: errorMessage(error), errors: [] };
    }
    const imported: ImportedStagedAsset[] = [];
    const errors: DraftImportError[] = [];
    const usedIds = new Set<ImportedAssetId>();
    const usedStorageKeys = new Set<string>();
    for (const [index, candidate] of candidates.slice(0, 9).entries()) {
      const itemUri = child(itemsUri, `item-${index}`);
      try {
        await files.ensureDirectory(itemUri);
        await files.ensureDirectory(child(itemUri, "assets"));
        await files.ensureDirectory(child(itemUri, "previews"));
        await files.ensureDirectory(child(itemUri, "metadata"));
        const staged = await stageCandidate(itemUri, candidate, index, usedIds, usedStorageKeys);
        const sourceOriginal = descriptorUri(itemUri, staged.entry, "original");
        const sourcePreview = descriptorUri(itemUri, staged.entry, "preview");
        const sourceMetadata = descriptorUri(itemUri, staged.entry, "metadata");
        const targetOriginal = descriptorUri(aggregateUri, staged.entry, "original");
        const targetPreview = descriptorUri(aggregateUri, staged.entry, "preview");
        const targetMetadata = descriptorUri(aggregateUri, staged.entry, "metadata");
        if (
          sourceOriginal === null ||
          sourcePreview === null ||
          targetOriginal === null ||
          targetPreview === null
        ) {
          throw new Error("asset descriptor is incomplete");
        }
        const published: string[] = [];
        try {
          await files.moveFile(sourceOriginal, targetOriginal);
          published.push(targetOriginal);
          await files.moveFile(sourcePreview, targetPreview);
          published.push(targetPreview);
          if (sourceMetadata !== null && targetMetadata !== null) {
            await files.moveFile(sourceMetadata, targetMetadata);
            published.push(targetMetadata);
          }
          imported.push(staged);
          usedIds.add(staged.entry.id);
          usedStorageKeys.add(staged.entry.storageKey);
        } catch (error: unknown) {
          for (const uri of published) await safeRemoveFile(uri);
          throw error;
        }
      } catch (error: unknown) {
        errors.push({ index, sourceUri: candidate.uri, message: errorMessage(error) });
      } finally {
        await safeRemoveDirectory(itemUri);
      }
    }
    for (let index = 9; index < candidates.length; index += 1) {
      errors.push({
        index,
        sourceUri: candidates[index]?.uri ?? "",
        message: "image limit is 9",
      });
    }
    if (imported.length === 0) {
      await finishStagingOperation(operationUri);
      return { status: "not-created", errors };
    }
    const id = createDraftId();
    const document = createDocument(
      imported.map(({ image }) => image),
      options,
    );
    const catalog = parseCatalog(catalogJson(imported.map(({ entry }) => entry)));
    const publishedUri = draftUri(id);
    let publicationStarted = false;
    try {
      await files.writeText(child(aggregateUri, "catalog.json"), catalogJson(catalog.entries));
      await files.writeText(child(aggregateUri, "document.json"), JSON.stringify(document));
      if (await files.directoryExists(publishedUri)) throw new Error("Draft identity already exists");
      publicationStarted = true;
      await files.moveDirectory(aggregateUri, publishedUri);
      await finishStagingOperation(operationUri);
      return {
        status: "created",
        draftId: id,
        document,
        assets: createCatalogSnapshot(id, publishedUri, catalog),
        errors,
      };
    } catch (error: unknown) {
      if (publicationStarted) await safeRemoveDirectory(publishedUri);
      await finishStagingOperation(operationUri);
      return { status: "create-failed", message: errorMessage(error), errors };
    }
  };

  const saveUnserialized = async (
    id: DraftId,
    document: PlogDocument,
  ): Promise<SaveDraftResult> => {
    try {
      await initialize();
    } catch (error: unknown) {
      return { status: "save-failed", reason: "storage-failed", message: errorMessage(error) };
    }
    await maintainStaging();
    const validated = await validateAggregate(id);
    if (validated.status === "invalid") {
      return { status: "save-failed", reason: validated.reason };
    }
    let prospective: PlogDocument;
    try {
      prospective = parseDocumentJson(JSON.stringify(document));
    } catch (error: unknown) {
      return { status: "save-failed", reason: "document-corrupt", message: errorMessage(error) };
    }
    const byId = new Map(validated.catalog.entries.map((entry) => [entry.id, entry]));
    for (const image of prospective.sourceImages) {
      const entry = byId.get(image.id);
      if (entry === undefined) {
        return { status: "save-failed", reason: "asset-reference-missing" };
      }
      if (entry.width !== image.width || entry.height !== image.height) {
        return { status: "save-failed", reason: "asset-facts-mismatch" };
      }
      const original = descriptorUri(validated.uri, entry, "original");
      if (original === null || !(await originalFileExists(original))) {
        return { status: "save-failed", reason: "original-missing" };
      }
    }
    const uri = draftUri(id);
    const state = textFileState(files, child(uri, "document.json"), parseDocumentJson);
    try {
      const prospectiveJson = JSON.stringify(prospective);
      await recoverFile(files, state);
      await files.writeText(state.temporaryUri, prospectiveJson);
      await commitPreparedFile(
        files,
        state,
        async (currentUri) => (await files.readText(currentUri)) === prospectiveJson,
      );
      return { status: "saved", document: prospective };
    } catch (error: unknown) {
      return { status: "save-failed", reason: "storage-failed", message: errorMessage(error) };
    }
  };

  const ingestUnserialized = async (
    id: DraftId,
    candidates: readonly ImportCandidate[],
  ): Promise<IngestAssetsResult> => {
    const loaded = await load(id);
    if (loaded.status === "recovery-failed") {
      return {
        status: "ingest-failed",
        imported: [],
        errors: [],
        message: loaded.reason,
      };
    }
    const uri = draftUri(id);
    const catalogState = textFileState(files, child(uri, "catalog.json"), parseCatalog);
    let catalog: Catalog;
    try {
      catalog = parseCatalog(await files.readText(child(uri, "catalog.json")));
    } catch (error: unknown) {
      return {
        status: "ingest-failed",
        imported: [],
        errors: [],
        message: errorMessage(error),
      };
    }
    const imported: IngestedAsset[] = [];
    const errors: DraftImportError[] = [];
    const usedIds = new Set(catalog.entries.map(({ id: assetId }) => assetId));
    const usedStorageKeys = new Set(catalog.entries.map(({ storageKey }) => storageKey));
    const operationUri = child(stagingUri, assertStorageKey(createOperationId()));
    activeStagingOperations.add(normalizedDirectoryUri(operationUri));
    try {
      await files.ensureDirectory(operationUri);
    } catch (error: unknown) {
      await finishStagingOperation(operationUri);
      return {
        status: "ingest-failed",
        imported: [],
        errors: [],
        message: errorMessage(error),
      };
    }

    for (const [index, candidate] of candidates.slice(0, 9).entries()) {
      const itemUri = child(operationUri, `item-${index}`);
      try {
        await files.ensureDirectory(itemUri);
        await files.ensureDirectory(child(itemUri, "assets"));
        await files.ensureDirectory(child(itemUri, "previews"));
        await files.ensureDirectory(child(itemUri, "metadata"));
        const staged = await stageCandidate(
          itemUri,
          candidate,
          index,
          usedIds,
          usedStorageKeys,
        );
        const entry = staged.entry;
        const stagedOriginal = descriptorUri(itemUri, entry, "original");
        const stagedPreview = descriptorUri(itemUri, entry, "preview");
        const stagedMetadata = descriptorUri(itemUri, entry, "metadata");
        const publishedOriginal = descriptorUri(uri, entry, "original");
        const publishedPreview = descriptorUri(uri, entry, "preview");
        const publishedMetadata = descriptorUri(uri, entry, "metadata");
        if (
          stagedOriginal === null ||
          stagedPreview === null ||
          publishedOriginal === null ||
          publishedPreview === null
        ) {
          throw new Error("asset descriptor is incomplete");
        }

        const publishedUris: string[] = [];
        try {
          await files.moveFile(stagedOriginal, publishedOriginal);
          publishedUris.push(publishedOriginal);
          await files.moveFile(stagedPreview, publishedPreview);
          publishedUris.push(publishedPreview);
          if (stagedMetadata !== null && publishedMetadata !== null) {
            await files.moveFile(stagedMetadata, publishedMetadata);
            publishedUris.push(publishedMetadata);
          }
          const nextCatalog = parseCatalog(catalogJson([...catalog.entries, entry]));
          const nextCatalogJson = catalogJson(nextCatalog.entries);
          await recoverFile(files, catalogState);
          await files.writeText(catalogState.temporaryUri, nextCatalogJson);
          await commitPreparedFile(
            files,
            catalogState,
            async (currentUri) => (await files.readText(currentUri)) === nextCatalogJson,
          );
          catalog = nextCatalog;
          imported.push({ image: staged.image, sourceKind: entry.sourceKind });
          usedIds.add(entry.id);
          usedStorageKeys.add(entry.storageKey);
        } catch (error: unknown) {
          for (const publishedUri of publishedUris) await safeRemoveFile(publishedUri);
          throw error;
        }
      } catch (error: unknown) {
        errors.push({ index, sourceUri: candidate.uri, message: errorMessage(error) });
      } finally {
        await safeRemoveDirectory(itemUri);
      }
    }
    for (let index = 9; index < candidates.length; index += 1) {
      errors.push({
        index,
        sourceUri: candidates[index]?.uri ?? "",
        message: "image limit is 9",
      });
    }
    await finishStagingOperation(operationUri);
    return {
      status: "ingested",
      imported,
      errors,
      assets: createCatalogSnapshot(id, uri, catalog),
    };
  };

  const readPreviewUnserialized = async (
    id: DraftId,
    assetId: ImportedAssetId,
  ): Promise<ReadPreviewResult> => {
    const loaded = await load(id);
    if (loaded.status === "recovery-failed") {
      return { status: "preview-failed", reason: loaded.reason };
    }
    const uri = draftUri(id);
    let catalog: Catalog;
    try {
      catalog = parseCatalog(await files.readText(child(uri, "catalog.json")));
    } catch (error: unknown) {
      return {
        status: "preview-failed",
        reason: "catalog-corrupt",
        message: errorMessage(error),
      };
    }
    const entry = catalog.entries.find(({ id: candidateId }) => candidateId === assetId);
    if (entry === undefined) {
      return { status: "preview-failed", reason: "asset-reference-missing" };
    }
    const originalUri = descriptorUri(uri, entry, "original");
    const previewUri = descriptorUri(uri, entry, "preview");
    if (originalUri === null || !(await originalFileExists(originalUri))) {
      return { status: "preview-failed", reason: "original-missing" };
    }
    if (previewUri === null) {
      return { status: "preview-failed", reason: "preview-unavailable" };
    }
    const previewState: RecoverableFileState = {
      currentUri: previewUri,
      backupUri: `${previewUri}.backup`,
      temporaryUri: `${previewUri}.tmp`,
      isValid: previews.isValid,
    };
    try {
      await recoverFile(files, previewState);
      if (!(await previews.isValid(previewUri))) {
        try {
          const size = await previews.generate(originalUri, previewState.temporaryUri, 2048);
          if (
            !Number.isInteger(size.width) ||
            !Number.isInteger(size.height) ||
            size.width <= 0 ||
            size.height <= 0 ||
            Math.max(size.width, size.height) > 2048 ||
            !(await previews.isValid(previewState.temporaryUri))
          ) {
            throw new Error("rebuilt preview is invalid");
          }
          await commitPreparedFile(files, previewState, previews.isValid);
        } catch (error: unknown) {
          throw error;
        }
      }
      const snapshot = createCatalogSnapshot(id, uri, catalog);
      const descriptor = snapshot.resolve(assetId, "preview");
      if (descriptor === null) {
        return { status: "preview-failed", reason: "preview-unavailable" };
      }
      return { status: "ready", descriptor, assets: snapshot };
    } catch (error: unknown) {
      return {
        status: "preview-failed",
        reason: "preview-unavailable",
        message: errorMessage(error),
      };
    }
  };

  const read = (id: DraftId): Promise<ReadDraftResult> =>
    serializeDraftOperation(id, () => readUnserialized(id));
  const save = (id: DraftId, document: PlogDocument): Promise<SaveDraftResult> =>
    serializeDraftOperation(id, () => saveUnserialized(id, document));
  const ingest = (
    id: DraftId,
    candidates: readonly ImportCandidate[],
  ): Promise<IngestAssetsResult> =>
    serializeDraftOperation(id, () => ingestUnserialized(id, candidates));
  const readPreview = (
    id: DraftId,
    assetId: ImportedAssetId,
  ): Promise<ReadPreviewResult> =>
    serializeDraftOperation(id, () => readPreviewUnserialized(id, assetId));
  const maintainInactive = (id: DraftId): Promise<void> =>
    serializeDraftOperation(id, () => maintainInactiveUnserialized(id));

  return { create, read, save, ingest, readPreview, maintainInactive };
}
