import type { MetadataPolicy } from "@/core/document";

export const APP_SETTINGS_SCHEMA_VERSION = 1;

export interface AppSettings {
  readonly schemaVersion: typeof APP_SETTINGS_SCHEMA_VERSION;
  readonly defaultMetadataPolicy: MetadataPolicy;
}

export interface SettingsFileAdapter {
  readonly exists: (uri: string) => Promise<boolean>;
  readonly readText: (uri: string) => Promise<string>;
  readonly writeText: (uri: string, content: string) => Promise<void>;
}

export interface SettingsRepository {
  readonly load: () => Promise<AppSettings>;
  readonly save: (settings: AppSettings) => Promise<void>;
}

export function createDefaultAppSettings(): AppSettings {
  return {
    schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
    defaultMetadataPolicy: "strip",
  };
}

export function parseAppSettings(input: unknown): AppSettings {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("settings must be an object");
  }
  const record = input as Record<string, unknown>;
  if (record.schemaVersion !== APP_SETTINGS_SCHEMA_VERSION) {
    throw new Error("settings schema is not supported");
  }
  if (record.defaultMetadataPolicy !== "strip" && record.defaultMetadataPolicy !== "retain-basic") {
    throw new Error("default metadata policy is not supported");
  }
  return {
    schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
    defaultMetadataPolicy: record.defaultMetadataPolicy,
  };
}

export function createSettingsRepository(
  files: SettingsFileAdapter,
  settingsUri: string,
): SettingsRepository {
  return {
    load: async () => {
      if (!(await files.exists(settingsUri))) return createDefaultAppSettings();
      try {
        const input: unknown = JSON.parse(await files.readText(settingsUri));
        return parseAppSettings(input);
      } catch {
        return createDefaultAppSettings();
      }
    },
    save: async (settings) => {
      const validated = parseAppSettings(settings);
      await files.writeText(settingsUri, JSON.stringify(validated));
    },
  };
}
