import { Directory, File, Paths } from "expo-file-system";

import {
  createDraftLibrary,
  type DraftLibrary,
  type DraftLibraryFileAdapter,
  type DraftLibraryPreviewAdapter,
} from "./draftLibrary";
import { createSkiaPreviewGenerator } from "../image-import/skiaPreviewGenerator";
import { createExpoDraftThumbnailAdapter } from "./expoDraftThumbnailAdapter";

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
      await new File(sourceUri).move(new File(destinationUri), { overwrite: false });
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
    listFiles: async (uri) => {
      const directory = new Directory(uri);
      return directory.exists
        ? directory
            .list()
            .filter((entry): entry is File => entry instanceof File)
            .map((entry) => entry.uri)
        : [];
    },
  };
}

export interface ExpoDraftRuntimeStorage {
  readonly library: DraftLibrary;
}

export function createExpoDraftRuntimeStorage(): ExpoDraftRuntimeStorage {
  const root = new Directory(Paths.document, "plogkit");
  const files = createExpoDraftFiles();
  const previews: DraftLibraryPreviewAdapter = createSkiaPreviewGenerator();
  const thumbnails = createExpoDraftThumbnailAdapter();
  return {
    library: createDraftLibrary({ files, previews, thumbnails, rootUri: root.uri }),
  };
}
