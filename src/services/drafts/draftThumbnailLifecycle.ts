import {
  cloneDocument,
  type ImportedAssetId,
  type PlogDocument,
} from "@/core/document";
import {
  commitPreparedFile,
  recoverFile,
  type RecoverableFileAdapter,
  type RecoverableFileState,
} from "@/services/persistence/recoverableFile";

import type {
  AssetDescriptor,
  AssetCatalogSnapshot,
  AssetUsage,
  DraftId,
  DraftThumbnailAdapter,
  DraftThumbnailPair,
  DraftThumbnailProfile,
  DraftThumbnailSize,
} from "./draftLibrary";

interface DraftThumbnailPairRecord {
  readonly thumbnailPairSchemaVersion: 1;
  readonly draftId: string;
  readonly contentRevision: number;
  readonly profileVersion: number;
  readonly squareFile: string;
  readonly originalFile: string;
  readonly square: DraftThumbnailSize;
  readonly original: DraftThumbnailSize;
}

export interface DraftThumbnailSource {
  readonly document: PlogDocument;
  readonly assets: AssetCatalogSnapshot;
}

export type DraftThumbnailAttemptSettlement =
  | {
      readonly draftId: DraftId;
      readonly contentRevision: number;
      readonly status: "committed";
      readonly pair: DraftThumbnailPair;
    }
  | {
      readonly draftId: DraftId;
      readonly contentRevision: number;
      readonly status: "failed";
    };

export type DraftThumbnailRequestDisposition =
  | "scheduled"
  | "in-progress"
  | "already-attempted";

export interface DraftThumbnailFileAdapter extends RecoverableFileAdapter {
  readonly readText: (uri: string) => Promise<string>;
  readonly writeText: (uri: string, content: string) => Promise<void>;
  readonly listFiles: (uri: string) => Promise<readonly string[]>;
}

export interface DraftThumbnailLifecycleHost {
  /** Captures a trusted source through the shared same-Draft gate. */
  readonly capture: (id: DraftId, exactRevision: number) => Promise<DraftThumbnailSource | null>;
  /**
   * Re-enters the shared gate, revalidates the exact revision, commits the pair,
   * and projects that pair into the host snapshot before returning "committed".
   */
  readonly commitPairIfCurrent: (
    id: DraftId,
    exactRevision: number,
    source: DraftThumbnailSource,
    commitPair: () => Promise<DraftThumbnailPair>,
  ) => Promise<{ readonly status: "committed" } | { readonly status: "stale" }>;
  /** Reports a failed or stale attempt without reading host state. */
  readonly onAttemptFailed: (
    failure: Extract<DraftThumbnailAttemptSettlement, { readonly status: "failed" }>,
  ) => void;
  /** Removes an empty aggregate recreated by a discarded attempt after confirmed deletion. */
  readonly cleanupDiscardedGeneration: (id: DraftId) => Promise<void>;
}

export interface DraftThumbnailLifecycle {
  readonly inspect: (id: DraftId, maximumRevision?: number) => Promise<DraftThumbnailPair | null>;
  /**
   * A supplied source must have been captured by the host while it owned the
   * shared same-Draft gate for this exact committed revision. The lifecycle
   * snapshots it before returning so pending work cannot observe caller mutation.
   */
  readonly request: (
    id: DraftId,
    contentRevision: number,
    source?: DraftThumbnailSource,
  ) => DraftThumbnailRequestDisposition;
  /**
   * The caller already owns the shared same-Draft operation gate.
   */
  readonly maintain: (id: DraftId, maximumRevision: number) => Promise<void>;
}

export interface CreateDraftThumbnailLifecycleOptions {
  readonly files: DraftThumbnailFileAdapter;
  readonly thumbnails: DraftThumbnailAdapter;
  readonly profile: DraftThumbnailProfile;
  readonly draftUriFor: (id: DraftId) => string;
  readonly createGenerationId: () => string;
  readonly host: DraftThumbnailLifecycleHost;
}

interface RunningAttempt {
  readonly contentRevision: number;
  readonly squareUri: string;
  readonly originalUri: string;
}

interface PendingAttempt {
  readonly contentRevision: number;
  readonly source?: DraftThumbnailSource;
}

function child(parent: string, name: string): string {
  return `${parent.replace(/\/$/, "")}/${name}`;
}

function isDirectChild(parent: string, candidate: string): boolean {
  const prefix = `${parent.replace(/\/$/, "")}/`;
  if (!candidate.startsWith(prefix)) return false;
  const relative = candidate.slice(prefix.length);
  return relative.length > 0 && !relative.includes("/");
}

function assertStorageKey(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error("storage key must be path-safe");
  }
  return value;
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
    record.draftId.length === 0 ||
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
    draftId: record.draftId,
    contentRevision: record.contentRevision,
    profileVersion: record.profileVersion,
    squareFile: record.squareFile,
    originalFile: record.originalFile,
    square: parseThumbnailSize(record.square, "square"),
    original: parseThumbnailSize(record.original, "original"),
  });
}

function thumbnailUris(draftUri: string): {
  readonly directoryUri: string;
  readonly pairUri: string;
} {
  return {
    directoryUri: child(draftUri, "thumbnails"),
    pairUri: child(draftUri, "thumbnail-pair.json"),
  };
}

function pairFromRecord(
  directoryUri: string,
  record: DraftThumbnailPairRecord,
): DraftThumbnailPair {
  return Object.freeze({
    contentRevision: record.contentRevision,
    profileVersion: record.profileVersion,
    squareUri: child(directoryUri, record.squareFile),
    originalUri: child(directoryUri, record.originalFile),
  });
}

function thumbnailPairState(
  files: DraftThumbnailFileAdapter,
  id: DraftId,
  maximumRevision: number,
  directoryUri: string,
  pairUri: string,
): RecoverableFileState {
  return {
    currentUri: pairUri,
    backupUri: `${pairUri}.backup`,
    temporaryUri: `${pairUri}.tmp`,
    isValid: async (uri) => {
      if (!(await files.fileExists(uri))) return false;
      const json = await files.readText(uri);
      let record: DraftThumbnailPairRecord;
      try {
        record = parseThumbnailPairJson(json);
      } catch {
        return false;
      }
      if (record.draftId !== id || record.contentRevision > maximumRevision) return false;
      const pair = pairFromRecord(directoryUri, record);
      return (
        (await files.fileExists(pair.squareUri)) &&
        (await files.fileExists(pair.originalUri))
      );
    },
  };
}

function isPositiveSize(size: DraftThumbnailSize): boolean {
  return (
    Number.isInteger(size.width) &&
    size.width > 0 &&
    Number.isInteger(size.height) &&
    size.height > 0
  );
}

const ASSET_USAGES: readonly AssetUsage[] = ["preview", "original", "metadata"];

function snapshotSource(source: DraftThumbnailSource): DraftThumbnailSource {
  const entries = Object.freeze([...source.assets.entries]);
  const descriptors = new Map<string, ReadonlyMap<AssetUsage, AssetDescriptor | null>>(
    entries.map((assetId) => [
      assetId,
      new Map(
        ASSET_USAGES.map((usage) => {
          const descriptor = source.assets.resolve(assetId, usage);
          return [
            usage,
            descriptor === null ? null : Object.freeze({ ...descriptor }),
          ] as const;
        }),
      ),
    ]),
  );
  return Object.freeze({
    document: cloneDocument(source.document),
    assets: Object.freeze({
      entries,
      resolve: (assetId: ImportedAssetId, usage: AssetUsage) =>
        descriptors.get(assetId)?.get(usage) ?? null,
    }),
  });
}

export function createDraftThumbnailLifecycle({
  files,
  thumbnails,
  profile,
  draftUriFor,
  createGenerationId,
  host,
}: CreateDraftThumbnailLifecycleOptions): DraftThumbnailLifecycle {
  const running = new Map<DraftId, RunningAttempt>();
  const pending = new Map<DraftId, PendingAttempt>();
  const attempted = new Map<DraftId, Set<number>>();
  const maintaining = new Set<DraftId>();

  const inspect = async (
    id: DraftId,
    maximumRevision = Number.MAX_SAFE_INTEGER,
  ): Promise<DraftThumbnailPair | null> => {
    const { directoryUri, pairUri } = thumbnailUris(draftUriFor(id));
    const pairState = thumbnailPairState(
      files,
      id,
      maximumRevision,
      directoryUri,
      pairUri,
    );
    try {
      if (!(await recoverFile(files, pairState)) || !(await files.fileExists(pairUri))) {
        return null;
      }
      const record = parseThumbnailPairJson(await files.readText(pairUri));
      if (record.draftId !== id || record.contentRevision > maximumRevision) return null;
      const pair = pairFromRecord(directoryUri, record);
      if (
        !(await files.fileExists(pair.squareUri)) ||
        !(await files.fileExists(pair.originalUri))
      ) {
        return null;
      }
      return pair;
    } catch {
      return null;
    }
  };

  const maintainFiles = async (id: DraftId, maximumRevision: number): Promise<void> => {
    const { directoryUri, pairUri } = thumbnailUris(draftUriFor(id));
    const retained = new Set<string>();
    const active = running.get(id);
    if (active !== undefined) {
      retained.add(active.squareUri);
      retained.add(active.originalUri);
    }

    try {
      const pairState = thumbnailPairState(
        files,
        id,
        maximumRevision,
        directoryUri,
        pairUri,
      );
      const recovered = await recoverFile(files, pairState);
      if (!recovered && (await files.fileExists(pairUri))) return;
      if (recovered && (await files.fileExists(pairUri))) {
        const record = parseThumbnailPairJson(await files.readText(pairUri));
        if (record.draftId !== id || record.contentRevision > maximumRevision) return;
        const pair = pairFromRecord(directoryUri, record);
        const squareExists = await files.fileExists(pair.squareUri);
        const originalExists = await files.fileExists(pair.originalUri);
        if (squareExists && originalExists) {
          retained.add(pair.squareUri);
          retained.add(pair.originalUri);
        }
      }
    } catch {
      return;
    }

    let candidates: readonly string[];
    try {
      candidates = await files.listFiles(directoryUri);
    } catch {
      return;
    }
    for (const candidate of candidates) {
      if (!isDirectChild(directoryUri, candidate) || retained.has(candidate)) continue;
      try {
        await files.removeFile(candidate);
      } catch {
        // Derived orphan cleanup is best effort and is retried by later maintenance.
      }
    }
  };

  const publishPair = async (
    id: DraftId,
    contentRevision: number,
    squareFile: string,
    originalFile: string,
    generated: {
      readonly square: DraftThumbnailSize;
      readonly original: DraftThumbnailSize;
    },
  ): Promise<DraftThumbnailPair> => {
    const { directoryUri, pairUri } = thumbnailUris(draftUriFor(id));
    const squareUri = child(directoryUri, squareFile);
    const originalUri = child(directoryUri, originalFile);
    const [square, original] = await Promise.all([
      thumbnails.inspect(squareUri),
      thumbnails.inspect(originalUri),
    ]);
    if (
      square === null ||
      original === null ||
      !isPositiveSize(square) ||
      !isPositiveSize(original) ||
      square.width !== generated.square.width ||
      square.height !== generated.square.height ||
      original.width !== generated.original.width ||
      original.height !== generated.original.height ||
      square.width !== profile.squareSize ||
      square.height !== profile.squareSize ||
      Math.max(original.width, original.height) > profile.originalLongEdge
    ) {
      throw new Error("Generated Draft thumbnail pair is invalid");
    }

    const record: DraftThumbnailPairRecord = Object.freeze({
      thumbnailPairSchemaVersion: 1,
      draftId: id,
      contentRevision,
      profileVersion: profile.profileVersion,
      squareFile,
      originalFile,
      square,
      original,
    });
    const pairState = thumbnailPairState(
      files,
      id,
      contentRevision,
      directoryUri,
      pairUri,
    );
    const json = JSON.stringify(record);
    await recoverFile(files, pairState);
    await files.writeText(pairState.temporaryUri, json);
    await commitPreparedFile(
      files,
      pairState,
      async (currentUri) => (await files.readText(currentUri)) === json,
    );
    return pairFromRecord(directoryUri, record);
  };

  const discardGeneratedFiles = async (
    id: DraftId,
    attempt: RunningAttempt,
  ): Promise<void> => {
    for (const uri of [attempt.squareUri, attempt.originalUri]) {
      try {
        await files.removeFile(uri);
      } catch {
        // A later inactive maintenance pass can retry derived orphan cleanup.
      }
    }
    try {
      await host.cleanupDiscardedGeneration(id);
    } catch {
      // Reliable deletion state is owned by the host; cleanup remains best effort.
    }
  };

  function start(
    id: DraftId,
    contentRevision: number,
    suppliedSource?: DraftThumbnailSource,
  ): boolean {
    const revisions = attempted.get(id) ?? new Set<number>();
    revisions.add(contentRevision);
    attempted.set(id, revisions);
    let squareFile: string;
    let originalFile: string;
    let attempt: RunningAttempt;
    try {
      const generationId = assertStorageKey(createGenerationId());
      const prefix = `r${contentRevision}-p${profile.profileVersion}-${generationId}`;
      squareFile = `${prefix}-square.jpg`;
      originalFile = `${prefix}-original.jpg`;
      const { directoryUri } = thumbnailUris(draftUriFor(id));
      attempt = {
        contentRevision,
        squareUri: child(directoryUri, squareFile),
        originalUri: child(directoryUri, originalFile),
      };
      running.set(id, attempt);
    } catch {
      try {
        host.onAttemptFailed({ draftId: id, contentRevision, status: "failed" });
      } catch {
        // A malformed injected identity cannot let an observer fail the reliable Draft.
      }
      return false;
    }

    void (async () => {
      let committed = false;
      let commitCallbackStarted = false;
      let discardGenerated = false;
      try {
        const source = suppliedSource ?? (await host.capture(id, contentRevision));
        if (source !== null) {
          let generated: Awaited<ReturnType<DraftThumbnailAdapter["generate"]>>;
          try {
            generated = await thumbnails.generate({
              draftId: id,
              contentRevision,
              document: source.document,
              assets: source.assets,
              profile,
              squareUri: attempt.squareUri,
              originalUri: attempt.originalUri,
            });
          } catch (error: unknown) {
            discardGenerated = true;
            throw error;
          }
          const outcome = await host.commitPairIfCurrent(id, contentRevision, source, () => {
            commitCallbackStarted = true;
            return publishPair(id, contentRevision, squareFile, originalFile, generated);
          });
          committed = outcome.status === "committed";
          if (!committed && !commitCallbackStarted) discardGenerated = true;
        }
      } catch {
        if (!commitCallbackStarted) discardGenerated = true;
        // Thumbnails are derived data; a failed attempt cannot fail the reliable Draft.
      } finally {
        if (discardGenerated) await discardGeneratedFiles(id, attempt);
        if (!committed) {
          try {
            host.onAttemptFailed({ draftId: id, contentRevision, status: "failed" });
          } catch {
            // Observers cannot prevent scheduler cleanup or the newest pending attempt.
          }
        }
        running.delete(id);
        startNextPending(id);
      }
    })();
    return true;
  }

  function startNextPending(id: DraftId): void {
    if (running.has(id) || maintaining.has(id)) return;
    const next = pending.get(id);
    if (next === undefined) return;
    pending.delete(id);
    start(id, next.contentRevision, next.source);
  }

  const maintain = async (id: DraftId, maximumRevision: number): Promise<void> => {
    maintaining.add(id);
    try {
      await maintainFiles(id, maximumRevision);
    } finally {
      maintaining.delete(id);
      startNextPending(id);
    }
  };

  const request = (
    id: DraftId,
    contentRevision: number,
    source?: DraftThumbnailSource,
  ): DraftThumbnailRequestDisposition => {
    const active = running.get(id);
    const pendingAttempt = pending.get(id);
    if (
      active?.contentRevision === contentRevision ||
      pendingAttempt?.contentRevision === contentRevision
    ) {
      return "in-progress";
    }
    if (attempted.get(id)?.has(contentRevision) === true) return "already-attempted";
    if (active !== undefined && contentRevision <= active.contentRevision) {
      return "already-attempted";
    }
    if (pendingAttempt !== undefined && contentRevision < pendingAttempt.contentRevision) {
      return "already-attempted";
    }
    let capturedSource: DraftThumbnailSource | undefined;
    try {
      capturedSource = source === undefined ? undefined : snapshotSource(source);
    } catch {
      const revisions = attempted.get(id) ?? new Set<number>();
      revisions.add(contentRevision);
      attempted.set(id, revisions);
      try {
        host.onAttemptFailed({ draftId: id, contentRevision, status: "failed" });
      } catch {
        // An invalid source and a failed observer still cannot fail the reliable Draft.
      }
      return "already-attempted";
    }
    if (active === undefined && !maintaining.has(id)) {
      return start(id, contentRevision, capturedSource)
        ? "scheduled"
        : "already-attempted";
    }
    pending.set(id, {
      contentRevision,
      ...(capturedSource === undefined ? {} : { source: capturedSource }),
    });
    return "scheduled";
  };

  return { inspect, request, maintain };
}
