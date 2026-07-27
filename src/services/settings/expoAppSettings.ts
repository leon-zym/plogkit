import { File, Paths } from "expo-file-system";

import { createAppSettings } from "./appSettings";

const settingsFile = new File(Paths.document, "settings.json");

export const appSettings = createAppSettings(
  {
    exists: async (uri) => new File(uri).exists,
    readText: async (uri) => new File(uri).text(),
    writeText: async (uri, content) => {
      const file = new File(uri);
      file.create({ intermediates: true, overwrite: true });
      file.write(content);
    },
  },
  settingsFile.uri,
);
