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
  readonly editing: EditCommitModule;
  readonly assets: AssetCatalogSnapshot;
}

export class EditorRuntime {
  private readonly dependencies: EditorRuntimeDependencies;
  private handle: CurrentEditingSessionHandle | null = null;
  private restorePromise: Promise<RestoreDraftResult> | null = null;
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

  async prepareEditor(): Promise<PreparedEditor | null> {
    const restored = await this.restore();
    const handle = this.handle;
    if (restored.status !== "restored" || handle === null) return null;
    const previews = await handle.preparePreviews();
    if (previews.status !== "prepared") {
      throw new Error(
        previews.status === "preview-failed"
          ? (previews.message ?? previews.reason)
          : previews.status,
      );
    }
    return { editing: handle.editing, assets: handle.assets };
  }

  async choosePhotos(): Promise<CreateDraftResult> {
    const candidates = await this.dependencies.selectCandidates();
    if (candidates.length === 0) return { status: "not-created", errors: [] };
    const metadataPolicy = await this.dependencies.loadMetadataPolicy();
    const result = await this.dependencies.storage.library.create(candidates, { metadataPolicy });
    if (result.status !== "created") return result;
    const opened = await this.dependencies.session.open(result.draftId);
    if (opened.status === "open-failed") {
      throw new Error(`created Draft could not become current: ${opened.reason}`);
    }
    this.handle = opened.handle;
    await this.dependencies.storage.writeRecentDraftId(result.draftId);
    this.importErrors = result.errors.length;
    return result;
  }

  async flush(): Promise<FlushCurrentEditingSessionResult> {
    return this.dependencies.session.flush();
  }
}
