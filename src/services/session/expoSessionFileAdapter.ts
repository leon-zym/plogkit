import { Directory, File, Paths } from "expo-file-system";

import type { SessionFileAdapter, SessionPaths } from "./sessionRepository";

export function createExpoSessionPaths(): SessionPaths {
  const current = new Directory(Paths.document, "projects", "current");
  return {
    currentDirectoryUri: current.uri,
    assetsDirectoryUri: new Directory(current, "assets").uri,
    previewsDirectoryUri: new Directory(current, "previews").uri,
    backupDirectoryUri: new Directory(current, "backup").uri,
    documentUri: new File(current, "document.json").uri,
    temporaryDocumentUri: new File(current, "document.json.tmp").uri,
  };
}

export function createExpoSessionFileAdapter(): SessionFileAdapter {
  return {
    exists: async (uri) => new File(uri).exists,
    ensureDirectory: async (uri) => {
      new Directory(uri).create({ idempotent: true, intermediates: true });
    },
    readText: async (uri) => new File(uri).text(),
    writeText: async (uri, content) => {
      const file = new File(uri);
      file.create({ intermediates: true, overwrite: true });
      file.write(content);
    },
    move: async (sourceUri, destinationUri, options) => {
      await new File(sourceUri).move(new File(destinationUri), options);
    },
  };
}
