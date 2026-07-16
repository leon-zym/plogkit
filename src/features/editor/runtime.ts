import { createDocument, type PlogDocument } from "@/core/document";
import { createEditCommitModule, type EditCommitModule } from "@/core/editing";
import { File } from "expo-file-system";
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

const paths = createExpoSessionPaths();
const repository = createSessionRepository({
  files: createExpoSessionFileAdapter(),
  paths,
});

class EditorRuntime {
  private editing: EditCommitModule | null = null;
  private autosave: AutosaveScheduler | null = null;
  private restorePromise: Promise<RestoreSessionResult> | null = null;
  private importErrors = 0;

  getEditing(): EditCommitModule | null {
    return this.editing;
  }

  getSessionPaths() {
    return paths;
  }

  takeImportErrorCount(): number {
    const count = this.importErrors;
    this.importErrors = 0;
    return count;
  }

  private start(document: PlogDocument): EditCommitModule {
    const autosave = createAutosaveScheduler((nextDocument) => repository.save(nextDocument));
    this.autosave = autosave;
    this.editing = createEditCommitModule({
      initialDocument: document,
      onEditCommit: (nextDocument) => autosave.schedule(nextDocument),
    });
    return this.editing;
  }

  async restore(): Promise<RestoreSessionResult> {
    if (this.editing !== null) {
      return { status: "restored", document: this.editing.read().document };
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
    const document = createDocument(
      result.imported.map(({ image }) => image),
      {
        metadataPolicy: settings.defaultMetadataPolicy,
      },
    );
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
