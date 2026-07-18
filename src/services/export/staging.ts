import {
  ExportStagingError,
  type ExportOperation,
  type ExportStaging,
  type PrepareStaticImageInput,
  type PreparedExport,
} from "./types";

export interface ExportStagingFileAdapter {
  readonly ensureDirectory: (uri: string) => Promise<void>;
  readonly createDirectory: (uri: string) => Promise<void>;
  readonly listDirectories: (uri: string) => Promise<readonly string[]>;
  readonly writeBytes: (uri: string, bytes: Uint8Array) => Promise<void>;
  readonly removeDirectory: (uri: string) => Promise<void>;
}

export interface CreateExportStagingOptions {
  readonly files: ExportStagingFileAdapter;
  readonly rootUri: string;
  readonly createOperationId?: () => string;
}

export interface InitializableExportStaging extends ExportStaging {
  readonly initialize: () => Promise<void>;
}

let operationSequence = 0;

function nextOperationId(): string {
  operationSequence += 1;
  return `operation-${Date.now()}-${operationSequence}`;
}

function child(parent: string, name: string): string {
  return `${parent.replace(/\/$/, "")}/${name}`;
}

function pathSafeIdentity(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error("export operation identity must be path-safe");
  }
  return value;
}

/** Cache-only staging with eager crash recovery and one owned directory per export run. */
export function createExportStaging({
  files,
  rootUri,
  createOperationId = nextOperationId,
}: CreateExportStagingOptions): InitializableExportStaging {
  const root = rootUri.replace(/\/$/, "");
  const initialization = (async (): Promise<ExportStagingError | null> => {
    try {
      await files.ensureDirectory(root);
      const orphans = await files.listDirectories(root);
      for (const orphan of orphans) {
        try {
          await files.removeDirectory(orphan);
        } catch {
          // A later process start retries cleanup without blocking a new export.
        }
      }
      return null;
    } catch (error: unknown) {
      return new ExportStagingError("export staging could not be initialized", { cause: error });
    }
  })();

  const initialize = async (): Promise<void> => {
    const initializationError = await initialization;
    if (initializationError !== null) throw initializationError;
  };

  const createOperation = async (): Promise<ExportOperation> => {
    await initialize();
    const id = pathSafeIdentity(createOperationId());
    const directoryUri = child(root, id);
    try {
      await files.createDirectory(directoryUri);
    } catch (error: unknown) {
      throw new ExportStagingError("export operation directory could not be created", {
        cause: error,
      });
    }

    let cleaned = false;
    const prepareStaticImage = async ({
      bytes,
      mimeType,
      extension,
    }: PrepareStaticImageInput): Promise<PreparedExport> => {
      if (cleaned) throw new Error("export operation has already been cleaned");
      if (bytes.length === 0) throw new Error("export backend produced an empty encoded image");
      const uri = child(directoryUri, `output.${extension}`);
      try {
        await files.writeBytes(uri, bytes);
      } catch (error: unknown) {
        throw new ExportStagingError("PreparedExport could not be written", { cause: error });
      }
      return Object.freeze({
        kind: "static-image",
        operationId: id,
        uri,
        mimeType,
        extension,
      });
    };

    const cleanup = async (): Promise<void> => {
      if (cleaned) return;
      await files.removeDirectory(directoryUri);
      cleaned = true;
    };

    return Object.freeze({ id, directoryUri, prepareStaticImage, cleanup });
  };

  return Object.freeze({ initialize, createOperation });
}
