import { Directory, File, Paths } from "expo-file-system";

import {
  createExportStaging,
  type ExportStagingFileAdapter,
  type InitializableExportStaging,
} from "./staging";
import type { ExportStaging } from "./types";

function createExpoExportStagingFiles(): ExportStagingFileAdapter {
  return {
    ensureDirectory: async (uri) => {
      new Directory(uri).create({ idempotent: true, intermediates: true });
    },
    createDirectory: async (uri) => {
      new Directory(uri).create({ idempotent: false, intermediates: false });
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
    writeBytes: async (uri, bytes) => {
      const file = new File(uri);
      file.create({ intermediates: true, overwrite: false });
      file.write(bytes);
    },
    removeDirectory: async (uri) => {
      const directory = new Directory(uri);
      if (directory.exists) directory.delete();
    },
  };
}

let staging: InitializableExportStaging | null = null;

function getInitializableExpoExportStaging(): InitializableExportStaging {
  staging ??= createExportStaging({
    files: createExpoExportStagingFiles(),
    rootUri: new Directory(Paths.cache, "plogkit-export-staging").uri,
  });
  return staging;
}

export function initializeExpoExportStaging(): Promise<void> {
  return getInitializableExpoExportStaging().initialize();
}

export function getExpoExportStaging(): ExportStaging {
  return getInitializableExpoExportStaging();
}
