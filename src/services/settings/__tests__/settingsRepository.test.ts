import {
  APP_SETTINGS_SCHEMA_VERSION,
  createDefaultAppSettings,
  createSettingsRepository,
  parseAppSettings,
  type AppSettings,
  type SettingsFileAdapter,
} from "../settingsRepository";

function createMemoryFiles(initial?: string) {
  let content = initial;
  const files: SettingsFileAdapter = {
    exists: jest.fn(async () => content !== undefined),
    readText: jest.fn(async () => content ?? ""),
    writeText: jest.fn(async (_uri, nextContent) => {
      content = nextContent;
    }),
  };
  return { files, read: () => content };
}

describe("settings repository", () => {
  it("uses privacy-first defaults when no settings exist", async () => {
    const memory = createMemoryFiles();
    const repository = createSettingsRepository(memory.files, "settings.json");

    await expect(repository.load()).resolves.toEqual({
      schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
      defaultMetadataPolicy: "strip",
      draftThumbnailDisplay: "square",
    });
  });

  it("falls back to defaults when saved settings are invalid", async () => {
    const memory = createMemoryFiles('{"schemaVersion":1,"defaultMetadataPolicy":"gps"}');
    const repository = createSettingsRepository(memory.files, "settings.json");

    await expect(repository.load()).resolves.toEqual(createDefaultAppSettings());
  });

  it("persists the global metadata default independently", async () => {
    const memory = createMemoryFiles();
    const repository = createSettingsRepository(memory.files, "settings.json");
    const settings: AppSettings = {
      schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
      defaultMetadataPolicy: "retain-basic",
      draftThumbnailDisplay: "original",
    };

    await repository.save(settings);

    expect(JSON.parse(memory.read() ?? "")).toEqual(settings);
    await expect(repository.load()).resolves.toEqual(settings);
  });

  it("rejects unsupported schemas", () => {
    expect(() =>
      parseAppSettings({
        schemaVersion: APP_SETTINGS_SCHEMA_VERSION + 1,
        defaultMetadataPolicy: "strip",
        draftThumbnailDisplay: "square",
      }),
    ).toThrow("settings schema is not supported");
  });

  it("rejects an unsupported global Draft thumbnail display mode", () => {
    expect(() =>
      parseAppSettings({
        schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
        defaultMetadataPolicy: "strip",
        draftThumbnailDisplay: "stretch",
      }),
    ).toThrow("Draft thumbnail display is not supported");
  });
});
