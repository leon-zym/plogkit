import type { PlogDocument } from "@/core/document";
import type { EditCommitModule } from "@/core/editing";
import type { MetadataPolicy } from "@/core/exportPolicy";
import type {
  AssetCatalogSnapshot,
  CreateDraftResult,
  DraftId,
  DraftLibrary,
  DraftRecoveryFailure,
  ImportCandidate,
} from "@/services/drafts/draftLibrary";
import type {
  CurrentEditingSession,
  CurrentEditingSessionHandle,
  FlushCurrentEditingSessionResult,
} from "@/services/session/currentEditingSession";

export interface DraftRuntimeStorage {
  readonly library: DraftLibrary;
  readonly readRecentDraftId: () => Promise<DraftId | null>;
  readonly writeRecentDraftId: (id: DraftId) => Promise<void>;
}

export interface EditorRuntimeDependencies {
  readonly storage: DraftRuntimeStorage;
  readonly session: CurrentEditingSession;
  readonly selectCandidates: () => Promise<readonly ImportCandidate[]>;
  readonly loadMetadataPolicy: () => Promise<MetadataPolicy>;
}

export type RestoreDraftResult =
  | { readonly status: "none" }
  | { readonly status: "restored"; readonly draftId: DraftId; readonly document: PlogDocument }
  | {
      readonly status: "recovery-failed";
      readonly reason:
        | DraftRecoveryFailure
        | "locator-corrupt"
        | "session-busy"
        | "flush-failed";
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
      readonly reason:
        | DraftRecoveryFailure
        | "locator-corrupt"
        | "session-busy"
        | "flush-failed"
        | "busy"
        | "session-inactive";
    };

export class EditorRuntime {
  private readonly dependencies: EditorRuntimeDependencies;
  private handle: CurrentEditingSessionHandle | null = null;
  private restorePromise: Promise<RestoreDraftResult> | null = null;
  private preparePromise: Promise<PrepareEditorResult> | null = null;
  private importErrors = 0;

  constructor(dependencies: EditorRuntimeDependencies) {
    this.dependencies = dependencies;
  }

  takeImportErrorCount(): number {
    const count = this.importErrors;
    this.importErrors = 0;
    return count;
  }

  async restore(): Promise<RestoreDraftResult> {
    if (this.handle !== null) {
      return {
        status: "restored",
        draftId: this.handle.draftId,
        document: this.handle.editing.read().document,
      };
    }
    this.restorePromise ??= (async () => {
      let id: DraftId | null;
      try {
        id = await this.dependencies.storage.readRecentDraftId();
      } catch {
        return { status: "recovery-failed", reason: "locator-corrupt" } as const;
      }
      if (id === null) return { status: "none" } as const;
      const result = await this.dependencies.session.open(id);
      if (result.status === "open-failed") {
        const reason = result.reason === "busy" ? "session-busy" : result.reason;
        return { status: "recovery-failed", reason } as const;
      }
      this.handle = result.handle;
      return {
        status: "restored",
        draftId: id,
        document: result.handle.editing.read().document,
      } as const;
    })();
    try {
      return await this.restorePromise;
    } finally {
      this.restorePromise = null;
    }
  }

  prepareEditor(): Promise<PrepareEditorResult> {
    if (this.preparePromise !== null) return this.preparePromise;
    this.preparePromise = (async () => {
      try {
        const restored = await this.restore();
        if (restored.status === "none") return { status: "no-draft" };
        if (restored.status === "recovery-failed") {
          return { status: "unavailable", reason: restored.reason };
        }
        const handle = this.handle;
        if (handle === null) return { status: "unavailable", reason: "session-inactive" };
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
    const previousDraftId = this.handle?.draftId ?? null;
    await this.dependencies.storage.writeRecentDraftId(result.draftId);
    let opened: Awaited<ReturnType<CurrentEditingSession["open"]>>;
    try {
      opened = await this.dependencies.session.open(result.draftId);
    } catch (error) {
      if (previousDraftId !== null) {
        await this.dependencies.storage.writeRecentDraftId(previousDraftId);
      }
      throw error;
    }
    if (opened.status === "open-failed") {
      if (previousDraftId !== null) {
        await this.dependencies.storage.writeRecentDraftId(previousDraftId);
      }
      throw new Error(`created Draft could not become current: ${opened.reason}`);
    }
    this.handle = opened.handle;
    this.importErrors = result.errors.length;
    return result;
  }

  async flush(): Promise<FlushCurrentEditingSessionResult> {
    return this.dependencies.session.flush();
  }
}
