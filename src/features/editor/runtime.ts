import { createDocument, type PlogDocument } from "@/core/document";
import { File } from "expo-file-system";
import {
  createEditorDocumentStore,
  type EditorDocumentStore,
} from "@/features/editor/state/documentStore";
import { createExpoImageImportFileAdapter } from "@/services/image-import/expoImageFiles";
import { createExpoImagePickerSource } from "@/services/image-import/expoImagePickerSource";
import { importImages, type ImageImportResult } from "@/services/image-import/importImages";
import { parseImageMetadataSidecar, toExifDateTime } from "@/services/image-import/metadata";
import { createSkiaPreviewGenerator } from "@/services/image-import/skiaPreviewGenerator";
import type { BasicExifMetadata } from "@/services/export";
import {
  createAutosaveScheduler,
  type AutosaveScheduler,
} from "@/services/session/autosaveScheduler";
import {
  createExpoSessionFileAdapter,
  createExpoSessionPaths,
} from "@/services/session/expoSessionFileAdapter";
import {
  createSessionRepository,
  type RestoreSessionResult,
} from "@/services/session/sessionRepository";
import { settingsRuntime } from "@/services/settings/expoSettingsRuntime";
import { setExportSettings } from "@/core/operations";

const paths = createExpoSessionPaths();
const repository = createSessionRepository({
  files: createExpoSessionFileAdapter(),
  paths,
});

class EditorRuntime {
  private store: EditorDocumentStore | null = null;
  private autosave: AutosaveScheduler | null = null;
  private restorePromise: Promise<RestoreSessionResult> | null = null;
  private importErrors = 0;

  getStore(): EditorDocumentStore | null {
    return this.store;
  }

  getSessionPaths() {
    return paths;
  }

  takeImportErrorCount(): number {
    const count = this.importErrors;
    this.importErrors = 0;
    return count;
  }

  private start(document: PlogDocument): EditorDocumentStore {
    const autosave = createAutosaveScheduler((nextDocument) => repository.save(nextDocument));
    this.autosave = autosave;
    this.store = createEditorDocumentStore({
      initialDocument: document,
      onDocumentCommit: (nextDocument) => autosave.schedule(nextDocument),
    });
    return this.store;
  }

  async restore(): Promise<RestoreSessionResult> {
    if (this.store !== null) {
      return { status: "restored", document: this.store.getState().document };
    }
    this.restorePromise ??= repository.restore();
    const result = await this.restorePromise;
    this.restorePromise = null;
    if (result.status === "restored") this.start(result.document);
    return result;
  }

  async choosePhotos(): Promise<ImageImportResult> {
    const result = await importImages(createExpoImagePickerSource(), {
      files: createExpoImageImportFileAdapter(),
      previews: createSkiaPreviewGenerator(),
      assetsDirectoryUri: paths.assetsDirectoryUri,
      previewsDirectoryUri: paths.previewsDirectoryUri,
    });
    if (result.imported.length === 0) return result;

    await this.autosave?.dispose();
    const settings = await settingsRuntime.load();
    const initialDocument = createDocument(result.imported.map(({ image }) => image));
    const document = setExportSettings(initialDocument, {
      ...initialDocument.exportSettings,
      metadataPolicy: settings.defaultMetadataPolicy,
    });
    await repository.save(document);
    this.start(document);
    this.importErrors = result.errors.length;
    return result;
  }

  async flush(): Promise<void> {
    await this.autosave?.flush();
  }

  async readBasicMetadata(imageId: string): Promise<BasicExifMetadata | undefined> {
    const file = new File(paths.assetsDirectoryUri, `${imageId}.metadata.json`);
    if (!file.exists) return undefined;
    try {
      const input: unknown = JSON.parse(await file.text());
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

export const editorRuntime = new EditorRuntime();
