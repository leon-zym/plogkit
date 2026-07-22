import type { EditCommitModule } from "@/core/editing";
import type { MetadataPolicy } from "@/core/exportPolicy";
import type {
  AssetCatalogSnapshot,
  CreateDraftResult,
  DraftId,
  DraftLibrary,
  DraftLibraryState,
  DraftThumbnailPair,
  DraftRecoveryFailure,
  ImportCandidate,
} from "@/services/drafts/draftLibrary";
import type {
  CurrentEditingSession,
  CurrentEditingSessionHandle,
  DeleteCurrentEditingSessionResult,
  FlushCurrentEditingSessionResult,
} from "@/services/session/currentEditingSession";

export interface DraftRuntimeStorage {
  readonly library: DraftLibrary;
}

export interface EditorRuntimeDependencies {
  readonly storage: DraftRuntimeStorage;
  readonly session: CurrentEditingSession;
  readonly selectCandidates: () => Promise<readonly ImportCandidate[]>;
  readonly loadMetadataPolicy: () => Promise<MetadataPolicy>;
}

export type OpenDraftResult =
  | {
      readonly status: "opened";
      readonly draftId: DraftId;
      readonly contentRevision: number;
    }
  | {
      readonly status: "open-failed";
      readonly reason: DraftRecoveryFailure | "flush-failed" | "busy";
    };

export interface PreparedEditor {
  readonly status: "prepared";
  readonly editing: EditCommitModule;
  readonly assets: AssetCatalogSnapshot;
}

export type PrepareEditorResult =
  | PreparedEditor
  | { readonly status: "no-draft" }
  | {
      readonly status: "preview-failed";
      readonly reason: DraftRecoveryFailure | "preview-unavailable";
      readonly message?: string;
    }
  | {
      readonly status: "unavailable";
      readonly reason: DraftRecoveryFailure | "flush-failed" | "busy" | "session-inactive";
    };

export class EditorRuntime {
  private readonly dependencies: EditorRuntimeDependencies;
  private handle: CurrentEditingSessionHandle | null = null;
  private preparePromise: Promise<PrepareEditorResult> | null = null;
  private importErrors = 0;

  constructor(dependencies: EditorRuntimeDependencies) {
    this.dependencies = dependencies;
  }

  loadDraftLibrary(): Promise<DraftLibraryState> {
    return this.dependencies.storage.library.load();
  }

  getDraftLibraryState(): DraftLibraryState {
    return this.dependencies.storage.library.getState();
  }

  subscribeDraftLibrary(listener: () => void): () => void {
    return this.dependencies.storage.library.subscribe(listener);
  }

  reportThumbnailLoadFailure(id: DraftId, pair: DraftThumbnailPair): void {
    this.dependencies.storage.library.reportThumbnailLoadFailure(id, pair);
  }

  takeImportErrorCount(): number {
    const count = this.importErrors;
    this.importErrors = 0;
    return count;
  }

  async openDraft(id: DraftId): Promise<OpenDraftResult> {
    const result = await this.dependencies.session.open(id);
    if (result.status === "open-failed") return result;
    this.handle = result.handle;
    return {
      status: "opened",
      draftId: id,
      contentRevision: result.handle.contentRevision,
    };
  }

  prepareEditor(): Promise<PrepareEditorResult> {
    if (this.preparePromise !== null) return this.preparePromise;
    this.preparePromise = (async () => {
      try {
        const handle = this.handle;
        if (handle === null) return { status: "no-draft" };
        const previews = await handle.preparePreviews();
        if (previews.status === "preview-failed") {
          return {
            status: "preview-failed",
            reason: previews.reason,
            ...(previews.message === undefined ? {} : { message: previews.message }),
          };
        }
        if (previews.status !== "prepared") {
          return { status: "unavailable", reason: previews.status };
        }
        return { status: "prepared", editing: handle.editing, assets: handle.assets };
      } finally {
        this.preparePromise = null;
      }
    })();
    return this.preparePromise;
  }

  async choosePhotos(): Promise<CreateDraftResult> {
    const candidates = await this.dependencies.selectCandidates();
    if (candidates.length === 0) return { status: "not-created", errors: [] };
    const metadataPolicy = await this.dependencies.loadMetadataPolicy();
    const flushed = await this.dependencies.session.flush();
    if (flushed.status === "flush-failed") {
      throw new Error(flushed.message ?? flushed.reason);
    }
    const result = await this.dependencies.storage.library.create(candidates, { metadataPolicy });
    if (result.status !== "created") return result;
    const opened = await this.dependencies.session.open(result.draftId);
    if (opened.status === "open-failed") {
      throw new Error(`created Draft could not become current: ${opened.reason}`);
    }
    this.handle = opened.handle;
    this.importErrors = result.errors.length;
    return result;
  }

  async deleteDraft(id: DraftId): Promise<DeleteCurrentEditingSessionResult> {
    const result = await this.dependencies.session.delete(id);
    if (result.status === "deleted" && this.handle?.draftId === id) this.handle = null;
    return result;
  }

  flush(): Promise<FlushCurrentEditingSessionResult> {
    return this.dependencies.session.flush();
  }
}
