import { File, Paths } from "expo-file-system";

import { createAppSettings, type AppSettingsFileAdapter } from "./appSettings";

const settingsFile = new File(Paths.document, "settings.json");

export const expoAppSettingsFileAdapter: AppSettingsFileAdapter = {
  exists: async (uri) => new File(uri).exists,
  readText: async (uri) => new File(uri).text(),
  writeText: async (uri, content) => {
    const destination = new File(uri);
    const pending = new File(`${uri}.pending`);
    try {
      if (pending.exists) pending.delete();
      pending.create({ intermediates: true });
      pending.write(content);
      await pending.move(destination, { overwrite: true });
    } catch (error: unknown) {
      try {
        if (pending.exists) pending.delete();
      } catch {
        // The committed settings file remains authoritative; later saves retry pending cleanup.
      }
      throw error;
    }
  },
};

export const appSettings = createAppSettings(expoAppSettingsFileAdapter, settingsFile.uri);
