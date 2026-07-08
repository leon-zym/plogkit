import { Directory, File } from "expo-file-system";

import type { ImageImportFileAdapter } from "./importImages";

export function createExpoImageImportFileAdapter(): ImageImportFileAdapter {
  return {
    ensureDirectory: async (uri) => {
      new Directory(uri).create({ idempotent: true, intermediates: true });
    },
    copy: async (sourceUri, destinationUri) => {
      await new File(sourceUri).copy(new File(destinationUri), { overwrite: true });
    },
    writeText: async (uri, content) => {
      const file = new File(uri);
      file.create({ intermediates: true, overwrite: true });
      file.write(content);
    },
  };
}
