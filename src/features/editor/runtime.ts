import type { PlogDocument } from "@/core/document";
import { createEditCommitModule, type EditCommitModule } from "@/core/editing";
import type { MetadataPolicy } from "@/core/exportPolicy";
import { SKIA_EXPORT_CAPABILITIES } from "@/services/export/capabilities";
import type { BasicExifMetadata } from "@/services/export/exif";
import type {
  AssetCatalogSnapshot,
  CreateDraftResult,
  DraftId,
  DraftLibrary,
  DraftRecoveryFailure,
  ImportCandidate,
} from "@/services/drafts/draftLibrary";
import { parseImageMetadataSidecar, toExifDateTime } from "@/services/image-import/metadata";
import {
  createAutosaveScheduler,
  type AutosaveScheduler,
} from "@/services/session/autosaveScheduler";

export interface DraftRuntimeStorage {
  readonly library: DraftLibrary;
  readonly readRecentDraftId: () => Promise<DraftId | null>;
  readonly writeRecentDraftId: (id: DraftId) => Promise<void>;
}

export interface EditorRuntimeDependencies {
  readonly storage: DraftRuntimeStorage;
  readonly selectCandidates: () => Promise<readonly ImportCandidate[]>;
  readonly loadMetadataPolicy: () => Promise<MetadataPolicy>;
  readonly readMetadataText: (uri: string) => Promise<string | null>;
}

export type RestoreDraftResult =
  | { readonly status: "none" }
  | { readonly status: "restored"; readonly draftId: DraftId; readonly document: PlogDocument }
  | { readonly status: "recovery-failed"; readonly reason: DraftRecoveryFailure | "locator-corrupt" };

export interface PreparedEditor {
  readonly editing: EditCommitModule;
  readonly assets: AssetCatalogSnapshot;
}

export class EditorRuntime {
  private readonly dependencies: EditorRuntimeDependencies;
  private draftId: DraftId | null = null;
  private editing: EditCommitModule | null = null;
  private assets: AssetCatalogSnapshot | null = null;
  private autosave: AutosaveScheduler | null = null;
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

  private start(
    id: DraftId,
    document: PlogDocument,
    assets: AssetCatalogSnapshot,
  ): EditCommitModule {
    const autosave = createAutosaveScheduler(async (nextDocument) => {
      const result = await this.dependencies.storage.library.save(id, nextDocument);
      if (result.status === "save-failed") {
        throw new Error(result.message ?? result.reason);
      }
    });
    this.draftId = id;
    this.assets = assets;
    this.autosave = autosave;
    this.editing = createEditCommitModule({
      initialDocument: document,
      onEditCommit: (nextDocument) => autosave.schedule(nextDocument),
      exportCapabilities: SKIA_EXPORT_CAPABILITIES,
    });
    return this.editing;
  }

  async restore(): Promise<RestoreDraftResult> {
    if (this.editing !== null && this.draftId !== null) {
      return {
        status: "restored",
        draftId: this.draftId,
        document: this.editing.read().document,
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
      const result = await this.dependencies.storage.library.read(id);
      if (result.status === "recovery-failed") {
        return { status: "recovery-failed", reason: result.reason } as const;
      }
      this.start(id, result.document, result.assets);
      return { status: "restored", draftId: id, document: result.document } as const;
    })();
    try {
      return await this.restorePromise;
    } finally {
      this.restorePromise = null;
    }
  }

  async prepareEditor(): Promise<PreparedEditor | null> {
    const restored = await this.restore();
    if (
      restored.status !== "restored" ||
      this.draftId === null ||
      this.editing === null ||
      this.assets === null
    ) {
      return null;
    }
    for (const image of this.editing.read().document.sourceImages) {
      const preview = await this.dependencies.storage.library.readPreview(this.draftId, image.id);
      if (preview.status === "preview-failed") {
        throw new Error(preview.message ?? preview.reason);
      }
      this.assets = preview.assets;
    }
    return { editing: this.editing, assets: this.assets };
  }

  async choosePhotos(): Promise<CreateDraftResult> {
    const candidates = await this.dependencies.selectCandidates();
    const metadataPolicy = await this.dependencies.loadMetadataPolicy();
    const result = await this.dependencies.storage.library.create(candidates, { metadataPolicy });
    if (result.status !== "created") return result;
    await this.autosave?.dispose();
    await this.dependencies.storage.writeRecentDraftId(result.draftId);
    this.start(result.draftId, result.document, result.assets);
    this.importErrors = result.errors.length;
    return result;
  }

  async flush(): Promise<void> {
    await this.autosave?.flush();
  }

  async readBasicMetadata(imageId: PlogDocument["sourceImages"][number]["id"]): Promise<
    BasicExifMetadata | undefined
  > {
    const descriptor = this.assets?.resolve(imageId, "metadata") ?? null;
    if (descriptor === null) return undefined;
    try {
      const json = await this.dependencies.readMetadataText(descriptor.uri);
      if (json === null) return undefined;
      const input: unknown = JSON.parse(json);
      const metadata = parseImageMetadataSidecar(input);
      if (metadata === null) return undefined;
      return {
        dateTimeOriginal: toExifDateTime(metadata.capturedAt),
        make: metadata.deviceMake,
        model: metadata.deviceModel,
      };
    } catch {
      return undefined;
    }
  }
}
