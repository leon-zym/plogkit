import { File, Paths } from "expo-file-system";

import { createSettingsRepository, type AppSettings } from "./settingsRepository";

const settingsFile = new File(Paths.document, "settings.json");
const repository = createSettingsRepository(
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

class ExpoSettingsRuntime {
  private cache: AppSettings | null = null;

  async load(): Promise<AppSettings> {
    this.cache ??= await repository.load();
    return this.cache;
  }

  async save(settings: AppSettings): Promise<void> {
    await repository.save(settings);
    this.cache = settings;
  }
}

export const settingsRuntime = new ExpoSettingsRuntime();
