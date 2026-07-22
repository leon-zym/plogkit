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

export const DRAFT_THUMBNAIL_PROFILE = Object.freeze({
  profileVersion: 1,
  squareSize: 360,
  originalLongEdge: 720,
  codec: "jpeg" as const,
  quality: 0.82,
  colorSpace: "srgb" as const,
  metadata: "strip" as const,
});

export type DraftThumbnailProfile = typeof DRAFT_THUMBNAIL_PROFILE;

export interface DraftThumbnailSize {
  readonly width: number;
  readonly height: number;
}

export interface DraftThumbnailAdapter {
  readonly generate: (input: {
    readonly draftId: DraftId;
    readonly contentRevision: number;
    readonly document: PlogDocument;
    readonly assets: AssetCatalogSnapshot;
    readonly profile: DraftThumbnailProfile;
    readonly squareUri: string;
    readonly originalUri: string;
  }) => Promise<{
    readonly square: DraftThumbnailSize;
    readonly original: DraftThumbnailSize;
  }>;
  readonly inspect: (uri: string) => Promise<DraftThumbnailSize | null>;
}

export interface DraftThumbnailPair {
  readonly contentRevision: number;
  readonly profileVersion: number;
  readonly squareUri: string;
  readonly originalUri: string;
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
      readonly metadata: DraftMetadata;
      readonly contentRevision: number;
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
      readonly metadata: DraftMetadata;
      readonly contentRevision: number;
      readonly assets: AssetCatalogSnapshot;
    }
  | { readonly status: "recovery-failed"; readonly reason: DraftRecoveryFailure };

export type SaveDraftResult =
  | {
      readonly status: "saved";
      readonly document: PlogDocument;
      readonly metadata: DraftMetadata;
      readonly contentRevision: number;
    }
  | {
      readonly status: "save-failed";
      readonly reason: DraftRecoveryFailure | "storage-failed";
      readonly message?: string;
    };

export type DeleteDraftResult =
  | { readonly status: "deleted" }
  | {
      readonly status: "delete-failed";
      readonly reason: DraftRecoveryFailure | "storage-failed";
      readonly message?: string;
    }
  | { readonly status: "delete-unknown"; readonly message?: string };

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

export interface DraftMetadata {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type DraftListEntry =
  | {
      readonly status: "ready";
      readonly draftId: DraftId;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly contentRevision: number;
      readonly photoCount: number;
      readonly thumbnail: DraftThumbnailPair | null;
      readonly thumbnailStatus: "ready" | "generating" | "unavailable";
    }
  | {
      readonly status: "corrupt";
      readonly draftId: DraftId;
      readonly updatedAt: string | null;
      readonly photoCount: number | null;
      readonly reason: Exclude<DraftRecoveryFailure, "draft-not-found" | "storage-unavailable">;
      readonly thumbnail: DraftThumbnailPair | null;
    };

export type DraftLibraryState =
  | { readonly status: "uninitialized" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly entries: readonly DraftListEntry[] }
  | { readonly status: "storage-failed"; readonly message?: string };

export interface DraftLibrary {
  readonly load: () => Promise<DraftLibraryState>;
  readonly getState: () => DraftLibraryState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly create: (
    candidates: readonly ImportCandidate[],
    options: { readonly metadataPolicy: MetadataPolicy },
  ) => Promise<CreateDraftResult>;
  /** Pre-open aggregate read. Active/idempotent session access must retain its existing snapshot. */
  readonly read: (id: DraftId) => Promise<ReadDraftResult>;
  readonly save: (id: DraftId, document: PlogDocument) => Promise<SaveDraftResult>;
  /** Internal transaction capability. Application callers delete through CurrentEditingSession. */
  readonly deleteDraft: (id: DraftId) => Promise<DeleteDraftResult>;
  readonly ingest: (
    id: DraftId,
    candidates: readonly ImportCandidate[],
  ) => Promise<IngestAssetsResult>;
  readonly readPreview: (id: DraftId, assetId: ImportedAssetId) => Promise<ReadPreviewResult>;
  /** Visible decode failure invalidates both representations for this process and schedules rebuild. */
  readonly reportThumbnailLoadFailure: (id: DraftId, pair: DraftThumbnailPair) => void;
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

interface DraftRootRecord {
  readonly draftSchemaVersion: 1;
  readonly draftId: DraftId;
  readonly metadata: DraftMetadata;
  readonly contentRevision: number;
  readonly document: PlogDocument;
}

interface DraftPublicationRecord {
  readonly publicationSchemaVersion: 1;
  readonly draftId: DraftId;
}

interface DraftDeletionRecord {
  readonly deletionSchemaVersion: 1;
  readonly draftId: DraftId;
}

interface DraftThumbnailPairRecord {
  readonly thumbnailPairSchemaVersion: 1;
  readonly draftId: DraftId;
  readonly contentRevision: number;
  readonly profileVersion: number;
  readonly squareFile: string;
  readonly originalFile: string;
  readonly square: DraftThumbnailSize;
  readonly original: DraftThumbnailSize;
}

interface ImportedStagedAsset {
  readonly entry: CatalogEntry;
  readonly image: SourceImage;
}

interface ThumbnailRequest {
  readonly id: DraftId;
  readonly root: DraftRootRecord;
  readonly catalog: Catalog;
  readonly uri: string;
}

type ValidatedAggregate =
  | {
      readonly status: "valid";
      readonly uri: string;
      readonly root: DraftRootRecord;
      readonly catalog: Catalog;
    }
  | {
      readonly status: "invalid";
      readonly reason: Exclude<DraftRecoveryFailure, "storage-unavailable">;
      readonly root: DraftRootRecord | null;
    };

export interface CreateDraftLibraryOptions {
  readonly files: DraftLibraryFileAdapter;
  readonly previews: DraftLibraryPreviewAdapter;
  readonly thumbnails: DraftThumbnailAdapter;
  readonly rootUri: string;
  readonly createDraftId?: () => DraftId;
  readonly createAssetId?: (candidate: ImportCandidate, index: number) => ImportedAssetId;
  readonly createStorageKey?: () => string;
  readonly createOperationId?: () => string;
  readonly createThumbnailGenerationId?: () => string;
  readonly now?: () => string;
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

function draftIdFromStorageName(name: string): DraftId | null {
  if (!name.startsWith("draft-")) return null;
  const encoded = name.slice("draft-".length);
  if (encoded.length === 0 || encoded.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return null;
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const values = [...encoded].map((character) => alphabet.indexOf(character));
  if (values.some((value) => value < 0)) return null;
  const bytes: number[] = [];
  for (let index = 0; index < values.length; index += 4) {
    const first = values[index];
    const second = values[index + 1];
    if (first === undefined || second === undefined) return null;
    bytes.push((first << 2) | (second >>> 4));
    const third = values[index + 2];
    if (third !== undefined) {
      bytes.push(((second & 0x0f) << 4) | (third >>> 2));
      const fourth = values[index + 3];
      if (fourth !== undefined) bytes.push(((third & 0x03) << 6) | fourth);
    }
  }
  if (bytes.length === 0 || bytes.length % 2 !== 0) return null;
  let value = "";
  for (let index = 0; index < bytes.length; index += 2) {
    value += String.fromCharCode((bytes[index]! << 8) | bytes[index + 1]!);
  }
  const id = draftId(value);
  return storageDraftName(id) === name ? id : null;
}

function directoryName(uri: string): string {
  const normalized = normalizedDirectoryUri(uri);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
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

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function parseDraftRootJson(json: string): DraftRootRecord {
  const input: unknown = JSON.parse(json);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Draft root must be an object");
  }
  const record = input as Record<string, unknown>;
  if (record.draftSchemaVersion !== 1 || typeof record.draftId !== "string") {
    throw new Error("Draft root schema is invalid");
  }
  if (
    typeof record.contentRevision !== "number" ||
    !Number.isInteger(record.contentRevision) ||
    record.contentRevision <= 0
  ) {
    throw new Error("Draft content revision is invalid");
  }
  const metadata = record.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error("Draft metadata is invalid");
  }
  const metadataRecord = metadata as Record<string, unknown>;
  const document = parseDocumentJson(JSON.stringify(record.document));
  return Object.freeze({
    draftSchemaVersion: 1,
    draftId: draftId(record.draftId),
    metadata: Object.freeze({
      createdAt: parseTimestamp(metadataRecord.createdAt, "createdAt"),
      updatedAt: parseTimestamp(metadataRecord.updatedAt, "updatedAt"),
    }),
    contentRevision: record.contentRevision,
    document,
  });
}

function draftRootJson(root: DraftRootRecord): string {
  return JSON.stringify(root);
}

function parsePublicationJson(json: string): DraftPublicationRecord {
  const input: unknown = JSON.parse(json);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Draft publication must be an object");
  }
  const record = input as Record<string, unknown>;
  if (record.publicationSchemaVersion !== 1 || typeof record.draftId !== "string") {
    throw new Error("Draft publication schema is invalid");
  }
  return Object.freeze({ publicationSchemaVersion: 1, draftId: draftId(record.draftId) });
}

function publicationJson(id: DraftId): string {
  return JSON.stringify({ publicationSchemaVersion: 1, draftId: id });
}

function parseDeletionJson(json: string): DraftDeletionRecord {
  const input: unknown = JSON.parse(json);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Draft deletion marker must be an object");
  }
  const record = input as Record<string, unknown>;
  if (record.deletionSchemaVersion !== 1 || typeof record.draftId !== "string") {
    throw new Error("Draft deletion marker schema is invalid");
  }
  return Object.freeze({ deletionSchemaVersion: 1, draftId: draftId(record.draftId) });
}

function deletionJson(id: DraftId): string {
  return JSON.stringify({ deletionSchemaVersion: 1, draftId: id });
}

function parseThumbnailSize(value: unknown, label: string): DraftThumbnailSize {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} thumbnail size is invalid`);
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.width !== "number" ||
    !Number.isInteger(record.width) ||
    record.width <= 0 ||
    typeof record.height !== "number" ||
    !Number.isInteger(record.height) ||
    record.height <= 0
  ) {
    throw new Error(`${label} thumbnail size is invalid`);
  }
  return Object.freeze({ width: record.width, height: record.height });
}

function parseThumbnailPairJson(json: string): DraftThumbnailPairRecord {
  const input: unknown = JSON.parse(json);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Draft thumbnail pair must be an object");
  }
  const record = input as Record<string, unknown>;
  if (
    record.thumbnailPairSchemaVersion !== 1 ||
    typeof record.draftId !== "string" ||
    typeof record.contentRevision !== "number" ||
    !Number.isInteger(record.contentRevision) ||
    record.contentRevision <= 0 ||
    typeof record.profileVersion !== "number" ||
    !Number.isInteger(record.profileVersion) ||
    record.profileVersion <= 0 ||
    typeof record.squareFile !== "string" ||
    !/^[A-Za-z0-9_-]+\.jpg$/.test(record.squareFile) ||
    typeof record.originalFile !== "string" ||
    !/^[A-Za-z0-9_-]+\.jpg$/.test(record.originalFile) ||
    record.squareFile === record.originalFile
  ) {
    throw new Error("Draft thumbnail pair schema is invalid");
  }
  return Object.freeze({
    thumbnailPairSchemaVersion: 1,
    draftId: draftId(record.draftId),
    contentRevision: record.contentRevision,
    profileVersion: record.profileVersion,
    squareFile: record.squareFile,
    originalFile: record.originalFile,
    square: parseThumbnailSize(record.square, "square"),
    original: parseThumbnailSize(record.original, "original"),
  });
}

function thumbnailPairJson(record: DraftThumbnailPairRecord): string {
  return JSON.stringify(record);
}

function readyListEntry(
  root: DraftRootRecord,
  thumbnail: DraftThumbnailPair | null = null,
  thumbnailStatus: "ready" | "generating" | "unavailable" = "generating",
): Extract<DraftListEntry, { status: "ready" }> {
  return Object.freeze({
    status: "ready",
    draftId: root.draftId,
    createdAt: root.metadata.createdAt,
    updatedAt: root.metadata.updatedAt,
    contentRevision: root.contentRevision,
    photoCount: root.document.sourceImages.length,
    thumbnail,
    thumbnailStatus,
  });
}

function sortDraftEntries(entries: readonly DraftListEntry[]): readonly DraftListEntry[] {
  return Object.freeze(
    [...entries].sort((left, right) => {
      if (left.updatedAt === null && right.updatedAt !== null) return -1;
      if (left.updatedAt !== null && right.updatedAt === null) return 1;
      if (left.updatedAt !== null && right.updatedAt !== null) {
        const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
        if (byUpdatedAt !== 0) return byUpdatedAt;
      }
      return left.draftId.localeCompare(right.draftId);
    }),
  );
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
  thumbnails,
  rootUri,
  createDraftId = defaultDraftId,
  createAssetId = defaultAssetId,
  createStorageKey = () => nextIdentity("file"),
  createOperationId = () => nextIdentity("operation"),
  createThumbnailGenerationId = () => nextIdentity("thumbnail"),
  now = () => new Date().toISOString(),
}: CreateDraftLibraryOptions): DraftLibrary {
  const draftsUri = child(rootUri, "drafts");
  const stagingUri = child(rootUri, "staging");
  const deletionsUri = child(rootUri, "deletions");
  let initializePromise: Promise<void> | null = null;
  const activeStagingOperations = new Set<string>();
  const draftOperationTails = new Map<DraftId, Promise<void>>();
  const confirmedDeletedIds = new Set<DraftId>();
  const unknownDeletionIds = new Set<DraftId>();
  const runningThumbnailIds = new Set<DraftId>();
  const pendingThumbnails = new Map<DraftId, ThumbnailRequest>();
  const attemptedThumbnailRevisions = new Map<DraftId, Set<number>>();
  let state: DraftLibraryState = Object.freeze({ status: "uninitialized" });
  let loadPromise: Promise<DraftLibraryState> | null = null;
  const listeners = new Set<() => void>();

  const publishState = (next: DraftLibraryState): DraftLibraryState => {
    state = next;
    for (const listener of listeners) listener();
    return next;
  };

  const installReadyEntries = (entries: readonly DraftListEntry[]): DraftLibraryState => {
    const ready = Object.freeze({
      status: "ready" as const,
      entries: sortDraftEntries(entries),
    });
    return publishState(ready);
  };

  const updateReadyEntries = (
    update: (entries: readonly DraftListEntry[]) => readonly DraftListEntry[],
  ): void => {
    if (state.status !== "ready") {
      throw new Error("Draft Library mutation requires a reliable snapshot");
    }
    installReadyEntries(update(state.entries));
  };

  const installStorageFailure = (error: unknown): DraftLibraryState => {
    const failed = Object.freeze({
      status: "storage-failed" as const,
      message: errorMessage(error),
    });
    return publishState(failed);
  };

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
        await files.ensureDirectory(deletionsUri);
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
  const draftThumbnailsUri = (id: DraftId): string => child(draftUri(id), "thumbnails");
  const thumbnailPairUri = (id: DraftId): string => child(draftUri(id), "thumbnail-pair.json");
  const deletionMarkerUri = (id: DraftId): string =>
    child(deletionsUri, `${storageDraftName(id)}.json`);

  const inspectPublication = async (
    id: DraftId,
    uri = draftUri(id),
  ): Promise<"valid" | "absent" | "invalid"> => {
    const publicationUri = child(uri, "publication.json");
    if (!(await files.fileExists(publicationUri))) return "absent";
    const text = await files.readText(publicationUri);
    let publication: DraftPublicationRecord;
    try {
      publication = parsePublicationJson(text);
    } catch {
      return "invalid";
    }
    return publication.draftId === id ? "valid" : "invalid";
  };

  const inspectDeletionMarker = async (
    id: DraftId,
  ): Promise<"valid" | "absent" | "invalid"> => {
    const markerUri = deletionMarkerUri(id);
    if (!(await files.fileExists(markerUri))) return "absent";
    const text = await files.readText(markerUri);
    let marker: DraftDeletionRecord;
    try {
      marker = parseDeletionJson(text);
    } catch {
      return "invalid";
    }
    return marker.draftId === id ? "valid" : "invalid";
  };

  const readCommittedThumbnailPair = async (
    id: DraftId,
    maximumRevision = Number.MAX_SAFE_INTEGER,
  ): Promise<DraftThumbnailPair | null> => {
    const pairUri = thumbnailPairUri(id);
    const pairState = textFileState(files, pairUri, parseThumbnailPairJson);
    try {
      if (!(await recoverFile(files, pairState)) || !(await files.fileExists(pairUri))) return null;
      const record = parseThumbnailPairJson(await files.readText(pairUri));
      if (record.draftId !== id || record.contentRevision > maximumRevision) return null;
      const squareUri = child(draftThumbnailsUri(id), record.squareFile);
      const originalUri = child(draftThumbnailsUri(id), record.originalFile);
      if (!(await files.fileExists(squareUri)) || !(await files.fileExists(originalUri))) return null;
      return Object.freeze({
        contentRevision: record.contentRevision,
        profileVersion: record.profileVersion,
        squareUri,
        originalUri,
      });
    } catch {
      return null;
    }
  };

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
    const rootRecordUri = child(uri, "draft.json");
    const catalogUri = child(uri, "catalog.json");
    if (!(await files.directoryExists(uri))) {
      return { status: "invalid", reason: "draft-not-found", root: null };
    }
    const rootRecovered = await recoverFile(
      files,
      textFileState(files, rootRecordUri, parseDraftRootJson),
    );
    if (!rootRecovered || !(await files.fileExists(rootRecordUri))) {
      return { status: "invalid", reason: "document-corrupt", root: null };
    }
    const rootText = await files.readText(rootRecordUri);
    let root: DraftRootRecord;
    try {
      root = parseDraftRootJson(rootText);
    } catch {
      return { status: "invalid", reason: "document-corrupt", root: null };
    }
    if (root.draftId !== id) {
      return { status: "invalid", reason: "document-corrupt", root: null };
    }
    const catalogRecovered = await recoverFile(
      files,
      textFileState(files, catalogUri, parseCatalog),
    );
    if (!catalogRecovered || !(await files.fileExists(catalogUri))) {
      return { status: "invalid", reason: "catalog-corrupt", root };
    }
    const catalogText = await files.readText(catalogUri);
    let catalog: Catalog;
    try {
      catalog = parseCatalog(catalogText);
    } catch {
      return { status: "invalid", reason: "catalog-corrupt", root };
    }
    const byId = new Map(catalog.entries.map((entry) => [entry.id, entry]));
    for (const image of root.document.sourceImages) {
      const entry = byId.get(image.id);
      if (entry === undefined) {
        return { status: "invalid", reason: "asset-reference-missing", root };
      }
      if (entry.width !== image.width || entry.height !== image.height) {
        return { status: "invalid", reason: "asset-facts-mismatch", root };
      }
      const originalUri = descriptorUri(uri, entry, "original");
      if (originalUri === null || !(await files.fileExists(originalUri))) {
        return { status: "invalid", reason: "original-missing", root };
      }
    }
    return {
      status: "valid",
      uri,
      root,
      catalog,
    };
  };

  const loadAggregate = async (id: DraftId): Promise<ReadDraftResult> => {
    try {
      await initialize();
    } catch {
      return { status: "recovery-failed", reason: "storage-unavailable" };
    }
    await maintainStaging();
    let validated: ValidatedAggregate;
    try {
      if (confirmedDeletedIds.has(id) || (await inspectDeletionMarker(id)) === "valid") {
        return { status: "recovery-failed", reason: "draft-not-found" };
      }
      if ((await inspectPublication(id)) !== "valid") {
        return { status: "recovery-failed", reason: "draft-not-found" };
      }
      validated = await validateAggregate(id);
    } catch {
      return { status: "recovery-failed", reason: "storage-unavailable" };
    }
    if (validated.status === "invalid") {
      return { status: "recovery-failed", reason: validated.reason };
    }
    return {
      status: "ready",
      draftId: id,
      document: validated.root.document,
      metadata: validated.root.metadata,
      contentRevision: validated.root.contentRevision,
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
    let validated: ValidatedAggregate;
    try {
      if (confirmedDeletedIds.has(id) || (await inspectDeletionMarker(id)) === "valid") return;
      if ((await inspectPublication(id)) !== "valid") return;
      validated = await validateAggregate(id);
    } catch {
      return;
    }
    if (validated.status === "invalid") return;
    const { uri, root, catalog } = validated;
    const catalogUri = child(uri, "catalog.json");
    const catalogState = textFileState(files, catalogUri, parseCatalog);
    const live = new Set(root.document.sourceImages.map(({ id: assetId }) => assetId));
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

    const thumbnailsUri = draftThumbnailsUri(id);
    let retainedThumbnailUris: ReadonlySet<string>;
    try {
      const pairUri = thumbnailPairUri(id);
      const pairState = textFileState(files, pairUri, parseThumbnailPairJson);
      const recovered = await recoverFile(files, pairState);
      if (!recovered || !(await files.fileExists(pairUri))) {
        retainedThumbnailUris = new Set();
      } else {
        const pair = parseThumbnailPairJson(await files.readText(pairUri));
        if (pair.draftId !== id || pair.contentRevision > root.contentRevision) return;
        retainedThumbnailUris = new Set([
          child(thumbnailsUri, pair.squareFile),
          child(thumbnailsUri, pair.originalFile),
        ]);
      }
    } catch {
      return;
    }
    let thumbnailCandidates: readonly string[];
    try {
      thumbnailCandidates = await files.listFiles(thumbnailsUri);
    } catch {
      return;
    }
    for (const candidate of thumbnailCandidates) {
      if (isDirectChild(thumbnailsUri, candidate) && !retainedThumbnailUris.has(candidate)) {
        await safeRemoveFile(candidate);
      }
    }
  };

  const readUnserialized = async (id: DraftId): Promise<ReadDraftResult> => {
    try {
      await initialize();
    } catch {
      return { status: "recovery-failed", reason: "storage-unavailable" };
    }
    return loadAggregate(id);
  };

  const markThumbnailGenerationFinished = (
    id: DraftId,
    revision: number,
    succeeded: boolean,
  ): void => {
    if (state.status !== "ready") return;
    const entry = state.entries.find(
      (candidate): candidate is Extract<DraftListEntry, { status: "ready" }> =>
        candidate.status === "ready" && candidate.draftId === id,
    );
    if (entry === undefined || entry.contentRevision !== revision) return;
    if (succeeded) return;
    updateReadyEntries((entries) =>
      entries.map((candidate) =>
        candidate.draftId === id && candidate.status === "ready"
          ? Object.freeze({
              ...candidate,
              thumbnailStatus: candidate.thumbnail === null ? "unavailable" : "ready",
            })
          : candidate,
      ),
    );
  };

  const commitThumbnailPair = async (
    request: ThumbnailRequest,
    squareFile: string,
    originalFile: string,
    generated: { readonly square: DraftThumbnailSize; readonly original: DraftThumbnailSize },
  ): Promise<boolean> => {
    return serializeDraftOperation(request.id, async () => {
      if (
        confirmedDeletedIds.has(request.id) ||
        (await inspectDeletionMarker(request.id)) === "valid" ||
        (await inspectPublication(request.id)) !== "valid"
      ) {
        return false;
      }
      const validated = await validateAggregate(request.id);
      if (
        validated.status !== "valid" ||
        validated.root.contentRevision !== request.root.contentRevision
      ) {
        return false;
      }
      const squareUri = child(draftThumbnailsUri(request.id), squareFile);
      const originalUri = child(draftThumbnailsUri(request.id), originalFile);
      const [square, original] = await Promise.all([
        thumbnails.inspect(squareUri),
        thumbnails.inspect(originalUri),
      ]);
      if (
        square === null ||
        original === null ||
        square.width !== generated.square.width ||
        square.height !== generated.square.height ||
        original.width !== generated.original.width ||
        original.height !== generated.original.height ||
        square.width !== DRAFT_THUMBNAIL_PROFILE.squareSize ||
        square.height !== DRAFT_THUMBNAIL_PROFILE.squareSize ||
        Math.max(original.width, original.height) > DRAFT_THUMBNAIL_PROFILE.originalLongEdge
      ) {
        return false;
      }
      const record: DraftThumbnailPairRecord = Object.freeze({
        thumbnailPairSchemaVersion: 1,
        draftId: request.id,
        contentRevision: request.root.contentRevision,
        profileVersion: DRAFT_THUMBNAIL_PROFILE.profileVersion,
        squareFile,
        originalFile,
        square,
        original,
      });
      const pairUri = thumbnailPairUri(request.id);
      const pairState = textFileState(files, pairUri, parseThumbnailPairJson);
      const json = thumbnailPairJson(record);
      await recoverFile(files, pairState);
      await files.writeText(pairState.temporaryUri, json);
      await commitPreparedFile(
        files,
        pairState,
        async (currentUri) => (await files.readText(currentUri)) === json,
      );
      const pair = Object.freeze({
        contentRevision: record.contentRevision,
        profileVersion: record.profileVersion,
        squareUri,
        originalUri,
      });
      if (state.status === "ready") {
        updateReadyEntries((entries) =>
          entries.map((entry) =>
            entry.draftId === request.id && entry.status === "ready"
              ? Object.freeze({ ...entry, thumbnail: pair, thumbnailStatus: "ready" })
              : entry,
          ),
        );
      }
      return true;
    });
  };

  const runThumbnailGeneration = async (request: ThumbnailRequest): Promise<void> => {
    const attempted = attemptedThumbnailRevisions.get(request.id) ?? new Set<number>();
    attempted.add(request.root.contentRevision);
    attemptedThumbnailRevisions.set(request.id, attempted);
    const generationId = assertStorageKey(createThumbnailGenerationId());
    const prefix = `r${request.root.contentRevision}-p${DRAFT_THUMBNAIL_PROFILE.profileVersion}-${generationId}`;
    const squareFile = `${prefix}-square.jpg`;
    const originalFile = `${prefix}-original.jpg`;
    const squareUri = child(draftThumbnailsUri(request.id), squareFile);
    const originalUri = child(draftThumbnailsUri(request.id), originalFile);
    let succeeded = false;
    try {
      const generated = await thumbnails.generate({
        draftId: request.id,
        contentRevision: request.root.contentRevision,
        document: request.root.document,
        assets: createCatalogSnapshot(request.id, request.uri, request.catalog),
        profile: DRAFT_THUMBNAIL_PROFILE,
        squareUri,
        originalUri,
      });
      succeeded = await commitThumbnailPair(
        request,
        squareFile,
        originalFile,
        generated,
      );
    } catch {
      succeeded = false;
    } finally {
      markThumbnailGenerationFinished(request.id, request.root.contentRevision, succeeded);
      runningThumbnailIds.delete(request.id);
      const pending = pendingThumbnails.get(request.id);
      pendingThumbnails.delete(request.id);
      if (pending !== undefined) queueThumbnail(pending);
    }
  };

  const queueThumbnail = (request: ThumbnailRequest): void => {
    const attempted = attemptedThumbnailRevisions.get(request.id);
    if (attempted?.has(request.root.contentRevision) === true) return;
    if (runningThumbnailIds.has(request.id)) {
      const pending = pendingThumbnails.get(request.id);
      if (pending === undefined || pending.root.contentRevision < request.root.contentRevision) {
        pendingThumbnails.set(request.id, request);
      }
      return;
    }
    runningThumbnailIds.add(request.id);
    void runThumbnailGeneration(request);
  };

  const scheduleThumbnailFromDisk = async (id: DraftId): Promise<void> => {
    try {
      const request = await serializeDraftOperation(
        id,
        async (): Promise<ThumbnailRequest | null> => {
          if (confirmedDeletedIds.has(id) || (await inspectDeletionMarker(id)) === "valid") {
            return null;
          }
          const validated = await validateAggregate(id);
          return validated.status === "valid"
            ? { id, root: validated.root, catalog: validated.catalog, uri: validated.uri }
            : null;
        },
      );
      if (request !== null) queueThumbnail(request);
    } catch {
      // Derived thumbnail scheduling never changes the reliable Draft snapshot.
    }
  };

  const create = async (
    candidates: readonly ImportCandidate[],
    options: { readonly metadataPolicy: MetadataPolicy },
  ): Promise<CreateDraftResult> => {
    if (candidates.length === 0) return { status: "not-created", errors: [] };
    const loaded = await loadLibrary();
    if (loaded.status !== "ready") {
      return {
        status: "create-failed",
        message:
          (loaded.status === "storage-failed" ? loaded.message : undefined) ??
          "Draft Library storage is unavailable",
        errors: [],
      };
    }
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
      await files.ensureDirectory(child(aggregateUri, "thumbnails"));
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
    const timestamp = parseTimestamp(now(), "current time");
    const metadata = Object.freeze({ createdAt: timestamp, updatedAt: timestamp });
    const root: DraftRootRecord = Object.freeze({
      draftSchemaVersion: 1,
      draftId: id,
      metadata,
      contentRevision: 1,
      document,
    });
    const catalog = parseCatalog(catalogJson(imported.map(({ entry }) => entry)));
    const publishedUri = draftUri(id);
    let publicationStarted = false;
    let publicationCommitted = false;
    let publicationOutcomeUnknown = false;
    try {
      await files.writeText(child(aggregateUri, "catalog.json"), catalogJson(catalog.entries));
      await files.writeText(child(aggregateUri, "draft.json"), draftRootJson(root));
      if (confirmedDeletedIds.has(id) || (await files.directoryExists(publishedUri))) {
        throw new Error("Draft identity already exists");
      }
      publicationStarted = true;
      await files.moveDirectory(aggregateUri, publishedUri);
      const validated = await validateAggregate(id);
      if (validated.status !== "valid") {
        throw new Error(`published Draft failed validation: ${validated.reason}`);
      }
      const publicationUri = child(publishedUri, "publication.json");
      let publicationWriteError: unknown = null;
      try {
        await files.writeText(publicationUri, publicationJson(id));
      } catch (error: unknown) {
        publicationWriteError = error;
      }
      let publication: "valid" | "absent" | "invalid";
      try {
        publication = await inspectPublication(id, publishedUri);
      } catch (error: unknown) {
        publicationOutcomeUnknown = true;
        throw error;
      }
      if (publication !== "valid") {
        throw publicationWriteError ?? new Error("Draft publication did not commit");
      }
      publicationCommitted = true;
      updateReadyEntries((entries) => [
        ...entries.filter((entry) => entry.draftId !== id),
        readyListEntry(root),
      ]);
      queueThumbnail({ id, root, catalog, uri: publishedUri });
      await finishStagingOperation(operationUri);
      return {
        status: "created",
        draftId: id,
        document,
        metadata,
        contentRevision: 1,
        assets: createCatalogSnapshot(id, publishedUri, catalog),
        errors,
      };
    } catch (error: unknown) {
      if (publicationStarted && !publicationCommitted && !publicationOutcomeUnknown) {
        await safeRemoveDirectory(publishedUri);
      }
      if (publicationOutcomeUnknown) installStorageFailure(error);
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
    let validated: ValidatedAggregate;
    try {
      if (confirmedDeletedIds.has(id) || (await inspectDeletionMarker(id)) === "valid") {
        return { status: "save-failed", reason: "draft-not-found" };
      }
      if ((await inspectPublication(id)) !== "valid") {
        return { status: "save-failed", reason: "draft-not-found" };
      }
      validated = await validateAggregate(id);
    } catch (error: unknown) {
      installStorageFailure(error);
      return { status: "save-failed", reason: "storage-failed", message: errorMessage(error) };
    }
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
      try {
        if (original === null || !(await files.fileExists(original))) {
          return { status: "save-failed", reason: "original-missing" };
        }
      } catch (error: unknown) {
        installStorageFailure(error);
        return {
          status: "save-failed",
          reason: "storage-failed",
          message: errorMessage(error),
        };
      }
    }
    if (JSON.stringify(validated.root.document) === JSON.stringify(prospective)) {
      return {
        status: "saved",
        document: validated.root.document,
        metadata: validated.root.metadata,
        contentRevision: validated.root.contentRevision,
      };
    }
    const uri = draftUri(id);
    const rootState = textFileState(files, child(uri, "draft.json"), parseDraftRootJson);
    try {
      const nextRoot: DraftRootRecord = Object.freeze({
        ...validated.root,
        metadata: Object.freeze({
          ...validated.root.metadata,
          updatedAt: parseTimestamp(now(), "current time"),
        }),
        contentRevision: validated.root.contentRevision + 1,
        document: prospective,
      });
      const prospectiveJson = draftRootJson(nextRoot);
      await recoverFile(files, rootState);
      await files.writeText(rootState.temporaryUri, prospectiveJson);
      await commitPreparedFile(
        files,
        rootState,
        async (currentUri) => (await files.readText(currentUri)) === prospectiveJson,
      );
      updateReadyEntries((entries) => {
        const previous = entries.find((entry) => entry.draftId === id);
        return [
          ...entries.filter((entry) => entry.draftId !== id),
          readyListEntry(
            nextRoot,
            previous?.thumbnail ?? null,
            "generating",
          ),
        ];
      });
      queueThumbnail({ id, root: nextRoot, catalog: validated.catalog, uri: validated.uri });
      return {
        status: "saved",
        document: prospective,
        metadata: nextRoot.metadata,
        contentRevision: nextRoot.contentRevision,
      };
    } catch (error: unknown) {
      installStorageFailure(error);
      return { status: "save-failed", reason: "storage-failed", message: errorMessage(error) };
    }
  };

  const ingestUnserialized = async (
    id: DraftId,
    candidates: readonly ImportCandidate[],
  ): Promise<IngestAssetsResult> => {
    const loaded = await loadAggregate(id);
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
    const loaded = await loadAggregate(id);
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

  const cleanupDeletedDraft = async (id: DraftId): Promise<void> => {
    await safeRemoveDirectory(draftUri(id));
    try {
      if (!(await files.directoryExists(draftUri(id)))) {
        await safeRemoveFile(deletionMarkerUri(id));
      }
    } catch {
      // Keep the marker until a later maintenance pass can prove the Draft directory is absent.
    }
  };

  const commitLogicalDeletion = (id: DraftId): DeleteDraftResult => {
    confirmedDeletedIds.add(id);
    unknownDeletionIds.delete(id);
    updateReadyEntries((entries) => entries.filter((entry) => entry.draftId !== id));
    void cleanupDeletedDraft(id);
    return { status: "deleted" };
  };

  const deleteDraftUnserialized = async (id: DraftId): Promise<DeleteDraftResult> => {
    if (unknownDeletionIds.has(id)) {
      unknownDeletionIds.delete(id);
      if (confirmedDeletedIds.has(id)) return commitLogicalDeletion(id);
      return { status: "delete-failed", reason: "storage-failed" };
    }
    if (confirmedDeletedIds.has(id)) return commitLogicalDeletion(id);

    let existing: "valid" | "absent" | "invalid";
    try {
      existing = await inspectDeletionMarker(id);
    } catch (error: unknown) {
      unknownDeletionIds.add(id);
      installStorageFailure(error);
      return { status: "delete-unknown", message: errorMessage(error) };
    }
    if (existing === "valid") return commitLogicalDeletion(id);
    if (existing === "invalid") {
      await safeRemoveFile(deletionMarkerUri(id));
      try {
        if ((await inspectDeletionMarker(id)) !== "absent") {
          return { status: "delete-failed", reason: "storage-failed" };
        }
      } catch (error: unknown) {
        return {
          status: "delete-failed",
          reason: "storage-failed",
          message: errorMessage(error),
        };
      }
    }
    try {
      if ((await inspectPublication(id)) !== "valid") {
        return { status: "delete-failed", reason: "draft-not-found" };
      }
    } catch (error: unknown) {
      return {
        status: "delete-failed",
        reason: "storage-failed",
        message: errorMessage(error),
      };
    }

    let writeError: unknown = null;
    try {
      await files.writeText(deletionMarkerUri(id), deletionJson(id));
    } catch (error: unknown) {
      writeError = error;
    }
    try {
      const committed = await inspectDeletionMarker(id);
      if (committed === "valid") return commitLogicalDeletion(id);
      if (committed === "invalid") await safeRemoveFile(deletionMarkerUri(id));
      return {
        status: "delete-failed",
        reason: "storage-failed",
        ...(writeError === null ? {} : { message: errorMessage(writeError) }),
      };
    } catch (error: unknown) {
      unknownDeletionIds.add(id);
      installStorageFailure(error);
      return { status: "delete-unknown", message: errorMessage(error) };
    }
  };

  const read = (id: DraftId): Promise<ReadDraftResult> =>
    serializeDraftOperation(id, () => readUnserialized(id));
  const save = async (id: DraftId, document: PlogDocument): Promise<SaveDraftResult> => {
    const loaded = await loadLibrary();
    if (loaded.status !== "ready") {
      return {
        status: "save-failed",
        reason: "storage-failed",
        ...(loaded.status === "storage-failed" && loaded.message !== undefined
          ? { message: loaded.message }
          : {}),
      };
    }
    return serializeDraftOperation(id, () => saveUnserialized(id, document));
  };
  const deleteDraft = async (id: DraftId): Promise<DeleteDraftResult> => {
    const loaded = await loadLibrary();
    if (loaded.status !== "ready") {
      return {
        status: unknownDeletionIds.has(id) ? "delete-unknown" : "delete-failed",
        ...(unknownDeletionIds.has(id) ? {} : { reason: "storage-failed" as const }),
        ...(loaded.status === "storage-failed" && loaded.message !== undefined
          ? { message: loaded.message }
          : {}),
      } as DeleteDraftResult;
    }
    return serializeDraftOperation(id, () => deleteDraftUnserialized(id));
  };
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

  const reportThumbnailLoadFailure = (id: DraftId, pair: DraftThumbnailPair): void => {
    if (state.status !== "ready") return;
    const entry = state.entries.find(
      (candidate): candidate is Extract<DraftListEntry, { status: "ready" }> =>
        candidate.status === "ready" && candidate.draftId === id,
    );
    if (
      entry?.thumbnail === null ||
      entry?.thumbnail.squareUri !== pair.squareUri ||
      entry.thumbnail.originalUri !== pair.originalUri
    ) {
      return;
    }
    updateReadyEntries((entries) =>
      entries.map((candidate) =>
        candidate.draftId === id && candidate.status === "ready"
          ? Object.freeze({ ...candidate, thumbnail: null, thumbnailStatus: "generating" })
          : candidate,
      ),
    );
    void scheduleThumbnailFromDisk(id);
  };

  const inspectDraftForList = async (
    id: DraftId,
    uri: string,
  ): Promise<DraftListEntry | null> => {
    if (confirmedDeletedIds.has(id)) return null;
    const publication = await inspectPublication(id, uri);
    if (publication !== "valid") {
      await safeRemoveDirectory(uri);
      return null;
    }
    const validated = await validateAggregate(id);
    if (validated.status === "valid") {
      const thumbnail = await readCommittedThumbnailPair(
        id,
        validated.root.contentRevision,
      );
      const current =
        thumbnail?.contentRevision === validated.root.contentRevision &&
        thumbnail.profileVersion === DRAFT_THUMBNAIL_PROFILE.profileVersion;
      return readyListEntry(
        validated.root,
        thumbnail,
        current ? "ready" : "generating",
      );
    }
    if (validated.reason === "draft-not-found") return null;
    return Object.freeze({
      status: "corrupt",
      draftId: id,
      updatedAt: validated.root?.metadata.updatedAt ?? null,
      photoCount: validated.root?.document.sourceImages.length ?? null,
      reason: validated.reason,
      thumbnail: await readCommittedThumbnailPair(
        id,
        validated.root?.contentRevision ?? Number.MAX_SAFE_INTEGER,
      ),
    });
  };

  const enumerateDeletionMarkers = async (): Promise<void> => {
    const markerUris = await files.listFiles(deletionsUri);
    for (const markerUri of markerUris) {
      const name = directoryName(markerUri);
      if (!name.endsWith(".json")) {
        await safeRemoveFile(markerUri);
        continue;
      }
      const id = draftIdFromStorageName(name.slice(0, -".json".length));
      if (id === null || deletionMarkerUri(id) !== markerUri) {
        await safeRemoveFile(markerUri);
        continue;
      }
      const marker = await inspectDeletionMarker(id);
      if (marker !== "valid") {
        if (marker === "invalid") await safeRemoveFile(markerUri);
        continue;
      }
      confirmedDeletedIds.add(id);
      await serializeDraftOperation(id, () => cleanupDeletedDraft(id));
    }
  };

  const enumerateDrafts = async (): Promise<readonly DraftListEntry[]> => {
    const directories = await files.listDirectories(draftsUri);
    const candidates = directories.flatMap((uri) => {
      const id = draftIdFromStorageName(directoryName(uri));
      return id === null ? [] : [{ id, uri }];
    });
    const entries: DraftListEntry[] = [];
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < candidates.length) {
        const candidate = candidates[nextIndex];
        nextIndex += 1;
        if (candidate === undefined) continue;
        const entry = await serializeDraftOperation(candidate.id, () =>
          inspectDraftForList(candidate.id, candidate.uri),
        );
        if (entry !== null) entries.push(entry);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, candidates.length) }, () => worker()),
    );
    return entries;
  };

  const loadLibrary = (): Promise<DraftLibraryState> => {
    if (state.status === "ready") return Promise.resolve(state);
    if (loadPromise !== null) return loadPromise;
    publishState(Object.freeze({ status: "loading" }));
    let operation!: Promise<DraftLibraryState>;
    operation = (async (): Promise<DraftLibraryState> => {
      try {
        await initialize();
        await maintainStaging();
        await enumerateDeletionMarkers();
        const ready = installReadyEntries(await enumerateDrafts());
        if (ready.status === "ready") {
          for (const entry of ready.entries) {
            if (entry.status === "ready" && entry.thumbnailStatus !== "ready") {
              void scheduleThumbnailFromDisk(entry.draftId);
            }
          }
        }
        return ready;
      } catch (error: unknown) {
        return installStorageFailure(error);
      } finally {
        if (loadPromise === operation) loadPromise = null;
      }
    })();
    loadPromise = operation;
    return operation;
  };

  return {
    load: loadLibrary,
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    create,
    read,
    save,
    deleteDraft,
    ingest,
    readPreview,
    reportThumbnailLoadFailure,
    maintainInactive,
  };
}
