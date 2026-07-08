import {
  createEmptyDocument,
  DocumentParseError,
  parseDocumentJson,
  type PlogDocument,
} from "@/core/document";

export interface SessionPaths {
  readonly currentDirectoryUri: string;
  readonly assetsDirectoryUri: string;
  readonly previewsDirectoryUri: string;
  readonly backupDirectoryUri: string;
  readonly documentUri: string;
  readonly temporaryDocumentUri: string;
}

export interface SessionFileAdapter {
  readonly exists: (uri: string) => Promise<boolean>;
  readonly ensureDirectory: (uri: string) => Promise<void>;
  readonly readText: (uri: string) => Promise<string>;
  readonly writeText: (uri: string, content: string) => Promise<void>;
  readonly move: (
    sourceUri: string,
    destinationUri: string,
    options?: { readonly overwrite: boolean },
  ) => Promise<void>;
}

export type RestoreSessionResult =
  | { readonly status: "none" }
  | { readonly status: "restored"; readonly document: PlogDocument }
  | {
      readonly status: "recovery-failed";
      readonly reason: "corrupt" | "future-schema";
      readonly document: PlogDocument;
      readonly backupUri: string;
    };

export interface SessionRepository {
  readonly save: (document: PlogDocument) => Promise<void>;
  readonly restore: () => Promise<RestoreSessionResult>;
}

export interface CreateSessionRepositoryOptions {
  readonly files: SessionFileAdapter;
  readonly paths: SessionPaths;
  readonly now?: () => number;
}

function childUri(directoryUri: string, name: string): string {
  return `${directoryUri.replace(/\/$/, "")}/${name}`;
}

export function createSessionRepository({
  files,
  paths,
  now = Date.now,
}: CreateSessionRepositoryOptions): SessionRepository {
  const ensureCurrentDirectories = async (): Promise<void> => {
    await files.ensureDirectory(paths.currentDirectoryUri);
    await files.ensureDirectory(paths.assetsDirectoryUri);
    await files.ensureDirectory(paths.previewsDirectoryUri);
  };

  return {
    save: async (document) => {
      await ensureCurrentDirectories();
      await files.writeText(paths.temporaryDocumentUri, JSON.stringify(document));
      await files.move(paths.temporaryDocumentUri, paths.documentUri, { overwrite: true });
    },
    restore: async () => {
      if (!(await files.exists(paths.documentUri))) return { status: "none" };

      try {
        const document = parseDocumentJson(await files.readText(paths.documentUri));
        return { status: "restored", document };
      } catch (error: unknown) {
        const reason =
          error instanceof DocumentParseError && error.code === "future-schema-version"
            ? "future-schema"
            : "corrupt";
        await files.ensureDirectory(paths.backupDirectoryUri);
        const backupUri = childUri(paths.backupDirectoryUri, `document-${now()}.json`);
        await files.move(paths.documentUri, backupUri);
        return {
          status: "recovery-failed",
          reason,
          document: createEmptyDocument(),
          backupUri,
        };
      }
    },
  };
}
