import {
  MAX_SOURCE_IMAGES,
  type ImportedAssetId,
  type PlogDocument,
} from "@/core/document";
import {
  createSessionEditCommitController,
  type EditCommitModule,
  type EditMessage,
  type EditResult,
} from "@/core/editing";
import { SKIA_EXPORT_CAPABILITIES } from "@/services/export/capabilities";
import type {
  AssetCatalogSnapshot,
  AssetUsage,
  DraftId,
  DraftImportError,
  DraftLibrary,
  DraftRecoveryFailure,
  DeleteDraftResult,
  ImportCandidate,
  IngestedAsset,
} from "@/services/drafts/draftLibrary";

export interface CurrentEditingSessionHandle {
  readonly draftId: DraftId;
  readonly contentRevision: number;
  readonly editing: EditCommitModule;
  readonly assets: AssetCatalogSnapshot;
  readonly preparePreviews: () => Promise<PrepareSessionPreviewsResult>;
  readonly addImages: (
    candidates: readonly ImportCandidate[],
  ) => Promise<SessionAssetMutationResult>;
  readonly replaceImage: (
    targetId: ImportedAssetId,
    candidate: ImportCandidate,
  ) => Promise<SessionAssetMutationResult>;
}

export type PrepareSessionPreviewsResult =
  | { readonly status: "prepared" }
  | {
      readonly status: "preview-failed";
      readonly reason: DraftRecoveryFailure | "preview-unavailable";
      readonly message?: string;
    }
  | { readonly status: "busy" | "session-inactive" };

export type SessionAssetMutationResult =
  | {
      readonly status: "completed";
      readonly imported: readonly IngestedAsset[];
      readonly errors: readonly DraftImportError[];
      readonly commit: EditResult | null;
    }
  | {
      readonly status: "publish-failed";
      readonly imported: readonly [];
      readonly errors: readonly DraftImportError[];
      readonly commit: null;
      readonly message?: string;
    }
  | {
      readonly status: "busy" | "session-inactive";
      readonly imported: readonly [];
      readonly errors: readonly [];
      readonly commit: null;
    };

export type OpenCurrentEditingSessionResult =
  | { readonly status: "opened"; readonly handle: CurrentEditingSessionHandle }
  | {
      readonly status: "open-failed";
      readonly reason: DraftRecoveryFailure | "flush-failed" | "busy";
    };

export type FlushCurrentEditingSessionResult =
  | { readonly status: "flushed" }
  | {
      readonly status: "flush-failed";
      readonly reason: DraftRecoveryFailure | "storage-failed" | "busy";
      readonly message?: string;
    };

export type DeleteCurrentEditingSessionResult =
  | { readonly status: "deleted" }
  | {
      readonly status: "delete-failed";
      readonly reason: DraftRecoveryFailure | "storage-failed" | "flush-failed" | "busy";
      readonly message?: string;
    }
  | { readonly status: "delete-unknown"; readonly message?: string };

export interface CurrentEditingSession {
  readonly open: (id: DraftId) => Promise<OpenCurrentEditingSessionResult>;
  readonly flush: () => Promise<FlushCurrentEditingSessionResult>;
  readonly delete: (id: DraftId) => Promise<DeleteCurrentEditingSessionResult>;
}

export interface CreateCurrentEditingSessionOptions {
  readonly library: DraftLibrary;
  readonly autosaveDelayMs?: number;
}

interface ActiveSession {
  readonly state: SessionState;
  readonly handle: CurrentEditingSessionHandle;
}

interface SessionState {
  readonly draftId: DraftId;
  active: boolean;
  assets: AssetCatalogSnapshot;
  contentRevision: number;
  revision: number;
  dirtyRevision: number;
  dirtyDocument: PlogDocument | null;
  timer: ReturnType<typeof setTimeout> | null;
  saveLoop: Promise<FlushCurrentEditingSessionResult> | null;
  assetOperation: boolean;
  assetOperationCompletion: Promise<void> | null;
  finishAssetOperation: (() => void) | null;
  switching: boolean;
  deletion: "none" | "in-progress" | "unknown";
}

function createStableAssetAccess(state: SessionState): AssetCatalogSnapshot {
  return Object.freeze({
    get entries() {
      return state.assets.entries;
    },
    resolve: (assetId: ImportedAssetId, usage: AssetUsage) =>
      state.assets.resolve(assetId, usage),
  });
}

export function createCurrentEditingSession({
  library,
  autosaveDelayMs = 300,
}: CreateCurrentEditingSessionOptions): CurrentEditingSession {
  if (!Number.isFinite(autosaveDelayMs) || autosaveDelayMs < 0) {
    throw new Error("autosave delay must be a non-negative finite number");
  }
  let active: ActiveSession | null = null;
  let opening: {
    readonly id: DraftId;
    readonly promise: Promise<OpenCurrentEditingSessionResult>;
  } | null = null;
  let deleting: {
    readonly id: DraftId;
    readonly promise: Promise<DeleteCurrentEditingSessionResult>;
  } | null = null;

  const clearAutosaveTimer = (state: SessionState): void => {
    if (state.timer === null) return;
    clearTimeout(state.timer);
    state.timer = null;
  };

  const startAssetOperation = (state: SessionState): void => {
    let finish!: () => void;
    state.assetOperation = true;
    state.assetOperationCompletion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    state.finishAssetOperation = finish;
  };

  const finishAssetOperation = (state: SessionState): void => {
    state.assetOperation = false;
    state.assetOperationCompletion = null;
    state.finishAssetOperation?.();
    state.finishAssetOperation = null;
  };

  const runSaveLoop = async (
    state: SessionState,
  ): Promise<FlushCurrentEditingSessionResult> => {
    while (state.dirtyDocument !== null) {
      const document = state.dirtyDocument;
      const revision = state.dirtyRevision;
      const result = await library.save(state.draftId, document);
      if (result.status === "save-failed") {
        return {
          status: "flush-failed",
          reason: result.reason,
          ...(result.message === undefined ? {} : { message: result.message }),
        };
      }
      state.contentRevision = result.contentRevision;
      if (state.dirtyRevision === revision) {
        state.dirtyDocument = null;
      }
    }
    return { status: "flushed" };
  };

  const drain = async (state: SessionState): Promise<FlushCurrentEditingSessionResult> => {
    clearAutosaveTimer(state);
    if (state.saveLoop !== null) return state.saveLoop;
    const loop = runSaveLoop(state);
    state.saveLoop = loop;
    try {
      const result = await loop;
      if (result.status === "flushed") clearAutosaveTimer(state);
      return result;
    } finally {
      if (state.saveLoop === loop) state.saveLoop = null;
    }
  };

  const scheduleAutosave = (state: SessionState, document: PlogDocument): void => {
    if (!state.active) return;
    state.revision += 1;
    state.dirtyRevision = state.revision;
    state.dirtyDocument = document;
    clearAutosaveTimer(state);
    state.timer = setTimeout(() => {
      state.timer = null;
      void drain(state);
    }, autosaveDelayMs);
  };

  const createActive = (
    id: DraftId,
    document: PlogDocument,
    assets: AssetCatalogSnapshot,
    contentRevision: number,
  ): ActiveSession => {
    const state: SessionState = {
      draftId: id,
      active: true,
      assets,
      contentRevision,
      revision: 0,
      dirtyRevision: 0,
      dirtyDocument: null,
      timer: null,
      saveLoop: null,
      assetOperation: false,
      assetOperationCompletion: null,
      finishAssetOperation: null,
      switching: false,
      deletion: "none",
    };
    const editController = createSessionEditCommitController({
      initialDocument: document,
      exportCapabilities: SKIA_EXPORT_CAPABILITIES,
      onEditCommit: (nextDocument) => scheduleAutosave(state, nextDocument),
    });
    const editing: EditCommitModule = Object.freeze({
      read: editController.editing.read,
      subscribe: editController.editing.subscribe,
      dispatch: (message: EditMessage): EditResult =>
        state.active && state.deletion === "none"
          ? editController.editing.dispatch(message)
          : { status: "unavailable", reason: "session-inactive" },
    });
    const preparePreviews = async (): Promise<PrepareSessionPreviewsResult> => {
      if (!state.active) return { status: "session-inactive" };
      if (state.assetOperation || state.switching || state.deletion !== "none") {
        return { status: "busy" };
      }
      startAssetOperation(state);
      try {
        for (const image of editing.read().document.sourceImages) {
          const result = await library.readPreview(id, image.id);
          if (result.status === "preview-failed") {
            return {
              status: "preview-failed",
              reason: result.reason,
              ...(result.message === undefined ? {} : { message: result.message }),
            };
          }
          state.assets = result.assets;
        }
        return { status: "prepared" };
      } finally {
        finishAssetOperation(state);
      }
    };
    const beginAssetOperation = (): SessionAssetMutationResult | null => {
      if (!state.active) {
        return {
          status: "session-inactive",
          imported: [],
          errors: [],
          commit: null,
        };
      }
      if (state.assetOperation || state.switching || state.deletion !== "none") {
        return { status: "busy", imported: [], errors: [], commit: null };
      }
      startAssetOperation(state);
      return null;
    };
    const addImages = async (
      candidates: readonly ImportCandidate[],
    ): Promise<SessionAssetMutationResult> => {
      const unavailable = beginAssetOperation();
      if (unavailable !== null) return unavailable;
      try {
        const available = Math.max(
          0,
          MAX_SOURCE_IMAGES - editing.read().document.sourceImages.length,
        );
        const accepted = candidates.slice(0, available);
        const overflow: DraftImportError[] = candidates.slice(available).map((item, offset) => ({
          index: available + offset,
          sourceUri: item.uri,
          message: `image limit is ${MAX_SOURCE_IMAGES}`,
        }));
        if (accepted.length === 0) {
          return {
            status: "completed",
            imported: [],
            errors: overflow,
            commit: null,
          };
        }
        const published = await library.ingest(id, accepted);
        if (published.status === "ingest-failed") {
          return {
            status: "publish-failed",
            imported: [],
            errors: [...published.errors, ...overflow],
            commit: null,
            ...(published.message === undefined ? {} : { message: published.message }),
          };
        }
        if (published.assets === undefined) {
          throw new Error("Draft Library ingest must return its published catalog snapshot");
        }
        state.assets = published.assets;
        const commit =
          published.imported.length === 0
            ? null
            : editController.commitPublishedAssets({
                type: "add",
                images: published.imported.map(({ image }) => image),
              });
        return {
          status: "completed",
          imported: published.imported,
          errors: [...published.errors, ...overflow],
          commit,
        };
      } finally {
        finishAssetOperation(state);
      }
    };
    const replaceImage = async (
      targetId: ImportedAssetId,
      candidate: ImportCandidate,
    ): Promise<SessionAssetMutationResult> => {
      const unavailable = beginAssetOperation();
      if (unavailable !== null) return unavailable;
      try {
        if (!editing.read().document.sourceImages.some(({ id: imageId }) => imageId === targetId)) {
          return {
            status: "completed",
            imported: [],
            errors: [],
            commit: { status: "rejected", code: "entity-not-found" },
          };
        }
        const published = await library.ingest(id, [candidate]);
        if (published.status === "ingest-failed") {
          return {
            status: "publish-failed",
            imported: [],
            errors: published.errors,
            commit: null,
            ...(published.message === undefined ? {} : { message: published.message }),
          };
        }
        if (published.assets === undefined) {
          throw new Error("Draft Library ingest must return its published catalog snapshot");
        }
        if (published.imported.length > 1) {
          throw new Error("single-image replacement published more than one asset");
        }
        state.assets = published.assets;
        const replacement = published.imported[0];
        const commit =
          replacement === undefined
            ? null
            : editController.commitPublishedAssets({
                type: "replace",
                targetId,
                image: replacement.image,
              });
        return {
          status: "completed",
          imported: published.imported,
          errors: published.errors,
          commit,
        };
      } finally {
        finishAssetOperation(state);
      }
    };
    const handle = Object.freeze({
      draftId: id,
      get contentRevision() {
        return state.contentRevision;
      },
      editing,
      assets: createStableAssetAccess(state),
      preparePreviews,
      addImages,
      replaceImage,
    });
    return { state, handle };
  };

  const flush = async (): Promise<FlushCurrentEditingSessionResult> => {
    if (active === null) return { status: "flushed" };
    if (
      active.state.assetOperation ||
      active.state.switching ||
      active.state.deletion !== "none"
    ) {
      return { status: "flush-failed", reason: "busy" };
    }
    return drain(active.state);
  };

  const performOpen = async (id: DraftId): Promise<OpenCurrentEditingSessionResult> => {
    const previous = active;
    if (previous !== null) {
      if (previous.state.assetOperation || previous.state.deletion !== "none") {
        return { status: "open-failed", reason: "busy" };
      }
      previous.state.switching = true;
    }
    try {
      if (previous !== null) {
        const flushed = await drain(previous.state);
        if (flushed.status === "flush-failed") {
          return { status: "open-failed", reason: "flush-failed" };
        }
      }

      try {
        await library.maintainInactive(id);
      } catch {
        // Maintenance is best effort and the target read remains authoritative.
      }
      const loaded = await library.read(id);
      if (loaded.status === "recovery-failed") {
        return { status: "open-failed", reason: loaded.reason };
      }

      if (previous !== null) {
        const latest = await drain(previous.state);
        if (latest.status === "flush-failed") {
          return { status: "open-failed", reason: "flush-failed" };
        }
      }

      const next = createActive(id, loaded.document, loaded.assets, loaded.contentRevision);
      active = next;
      if (previous !== null) {
        previous.state.active = false;
        clearAutosaveTimer(previous.state);
        try {
          await library.maintainInactive(previous.state.draftId);
        } catch {
          // Compaction is best effort after the new active session is already established.
        }
      }
      return { status: "opened", handle: next.handle };
    } finally {
      if (previous?.state.active) previous.state.switching = false;
    }
  };

  const open = (id: DraftId): Promise<OpenCurrentEditingSessionResult> => {
    if (active?.state.draftId === id && active.state.deletion === "none") {
      return Promise.resolve({ status: "opened", handle: active.handle });
    }
    if (opening !== null) {
      return opening.id === id
        ? opening.promise
        : Promise.resolve({ status: "open-failed", reason: "busy" });
    }
    const promise = performOpen(id).finally(() => {
      if (opening?.promise === promise) opening = null;
    });
    opening = { id, promise };
    return promise;
  };

  const mapDeleteResult = (
    result: DeleteDraftResult,
  ): DeleteCurrentEditingSessionResult => {
    if (result.status === "deleted") return result;
    if (result.status === "delete-unknown") {
      return {
        status: "delete-unknown",
        ...(result.message === undefined ? {} : { message: result.message }),
      };
    }
    return {
      status: "delete-failed",
      reason: result.reason,
      ...(result.message === undefined ? {} : { message: result.message }),
    };
  };

  const performDelete = async (id: DraftId): Promise<DeleteCurrentEditingSessionResult> => {
    const current = active;
    if (current === null || current.state.draftId !== id) {
      return mapDeleteResult(await library.deleteDraft(id));
    }
    const state = current.state;
    if (state.deletion === "in-progress") {
      return { status: "delete-failed", reason: "busy" };
    }

    if (state.deletion === "none") {
      state.deletion = "in-progress";
      clearAutosaveTimer(state);
      const assetOperationCompletion = state.assetOperationCompletion;
      if (assetOperationCompletion !== null) await assetOperationCompletion;
      const flushed = await drain(state);
      if (flushed.status === "flush-failed") {
        state.deletion = "none";
        return {
          status: "delete-failed",
          reason: "flush-failed",
          ...(flushed.message === undefined ? {} : { message: flushed.message }),
        };
      }
    }

    const result = await library.deleteDraft(id);
    if (result.status === "delete-unknown") {
      state.deletion = "unknown";
      return mapDeleteResult(result);
    }
    if (result.status === "delete-failed") {
      state.deletion = "none";
      return mapDeleteResult(result);
    }

    state.active = false;
    state.deletion = "unknown";
    clearAutosaveTimer(state);
    if (active?.state === state) active = null;
    return { status: "deleted" };
  };

  const deleteDraft = (id: DraftId): Promise<DeleteCurrentEditingSessionResult> => {
    if (deleting !== null) {
      return deleting.id === id
        ? deleting.promise
        : Promise.resolve({ status: "delete-failed", reason: "busy" });
    }
    const promise = performDelete(id).finally(() => {
      if (deleting?.promise === promise) deleting = null;
    });
    deleting = { id, promise };
    return promise;
  };

  return { open, flush, delete: deleteDraft };
}
