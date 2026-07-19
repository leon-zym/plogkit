import { Directory, File, Paths } from "expo-file-system";

import {
  createDraftLibrary,
  draftId,
  type DraftId,
  type DraftLibrary,
  type DraftLibraryFileAdapter,
  type DraftLibraryPreviewAdapter,
} from "./draftLibrary";
import { createSkiaPreviewGenerator } from "../image-import/skiaPreviewGenerator";

function createExpoDraftFiles(): DraftLibraryFileAdapter {
  return {
    fileExists: async (uri) => new File(uri).exists,
    directoryExists: async (uri) => new Directory(uri).exists,
    ensureDirectory: async (uri) => {
      new Directory(uri).create({ idempotent: true, intermediates: true });
    },
    readText: async (uri) => new File(uri).text(),
    writeText: async (uri, content) => {
      const file = new File(uri);
      file.create({ intermediates: true, overwrite: true });
      file.write(content);
    },
    copy: async (sourceUri, destinationUri) => {
      await new File(sourceUri).copy(new File(destinationUri), { overwrite: false });
    },
    moveFile: async (sourceUri, destinationUri) => {
      await new File(sourceUri).move(new File(destinationUri), { overwrite: true });
    },
    moveDirectory: async (sourceUri, destinationUri) => {
      await new Directory(sourceUri).move(new Directory(destinationUri), { overwrite: false });
    },
    removeFile: async (uri) => {
      const file = new File(uri);
      if (file.exists) file.delete();
    },
    removeDirectory: async (uri) => {
      const directory = new Directory(uri);
      if (directory.exists) directory.delete();
    },
    listDirectories: async (uri) => {
      const directory = new Directory(uri);
      return directory.exists
        ? directory
            .list()
            .filter((entry): entry is Directory => entry instanceof Directory)
            .map((entry) => entry.uri)
        : [];
    },
  };
}

export interface ExpoDraftRuntimeStorage {
  readonly library: DraftLibrary;
  readonly readRecentDraftId: () => Promise<DraftId | null>;
  readonly writeRecentDraftId: (id: DraftId) => Promise<void>;
}

export function createExpoDraftRuntimeStorage(): ExpoDraftRuntimeStorage {
  const root = new Directory(Paths.document, "plogkit");
  const files = createExpoDraftFiles();
  const previews: DraftLibraryPreviewAdapter = createSkiaPreviewGenerator();
  return {
    library: createDraftLibrary({ files, previews, rootUri: root.uri }),
    readRecentDraftId: async () => {
      const recent = new File(root, "recent-draft.json");
      if (!recent.exists) return null;
      const input: unknown = JSON.parse(await recent.text());
      if (typeof input !== "object" || input === null || !("draftId" in input)) {
        throw new Error("recent Draft locator is invalid");
      }
      const value = (input as { readonly draftId?: unknown }).draftId;
      if (typeof value !== "string" || value.length === 0) {
        throw new Error("recent Draft locator is invalid");
      }
      return draftId(value);
    },
    writeRecentDraftId: async (id) => {
      root.create({ idempotent: true, intermediates: true });
      const recentTemporary = new File(root, "recent-draft.json.tmp");
      recentTemporary.create({ intermediates: true, overwrite: true });
      recentTemporary.write(JSON.stringify({ draftId: id }));
      await recentTemporary.move(new File(root, "recent-draft.json"), { overwrite: true });
    },
  };
}
