import { expoAppSettingsFileAdapter } from "../expoAppSettings";

const mockContents = new Map<string, string>();
const mockEvents: string[] = [];
let mockFailWriteUri: string | null = null;
const mockFailMoveSources = new Set<string>();
const mockFailAfterMoveSources = new Set<string>();
const mockFailDeleteUris = new Set<string>();

function mockUri(parent: string | { readonly uri: string }, name?: string): string {
  const base = typeof parent === "string" ? parent : parent.uri;
  return name === undefined ? base : `${base.replace(/\/$/, "")}/${name}`;
}

jest.mock("expo-file-system", () => {
  class MockFile {
    uri: string;

    constructor(parent: string | { readonly uri: string }, name?: string) {
      this.uri = mockUri(parent, name);
    }

    get exists(): boolean {
      return mockContents.has(this.uri);
    }

    create(): void {
      mockEvents.push(`create ${this.uri}`);
      mockContents.set(this.uri, "");
    }

    delete(): void {
      mockEvents.push(`delete ${this.uri}`);
      if (mockFailDeleteUris.has(this.uri)) throw new Error("delete failed");
      mockContents.delete(this.uri);
    }

    write(content: string): void {
      mockEvents.push(`write ${this.uri}`);
      if (mockFailWriteUri === this.uri) throw new Error("write failed");
      mockContents.set(this.uri, content);
    }

    async text(): Promise<string> {
      const content = mockContents.get(this.uri);
      if (content === undefined) throw new Error(`missing ${this.uri}`);
      return content;
    }

    async move(destination: MockFile, options?: { overwrite?: boolean }): Promise<void> {
      const sourceUri = this.uri;
      mockEvents.push(
        `move ${sourceUri} -> ${destination.uri}${options?.overwrite ? " overwrite" : ""}`,
      );
      if (options?.overwrite && mockContents.has(destination.uri)) {
        mockEvents.push(`delete ${destination.uri} for overwrite`);
        mockContents.delete(destination.uri);
      }
      if (mockFailMoveSources.has(sourceUri)) throw new Error("move failed");
      const content = mockContents.get(sourceUri);
      if (content === undefined) throw new Error(`missing ${sourceUri}`);
      mockContents.delete(sourceUri);
      mockContents.set(destination.uri, content);
      this.uri = destination.uri;
      if (mockFailAfterMoveSources.has(sourceUri)) throw new Error("move reported failure");
    }
  }

  return {
    File: MockFile,
    Paths: { document: "memory://documents" },
  };
});

describe("Expo App Settings file adapter", () => {
  const settingsUri = "memory://documents/settings.json";
  const pendingUri = `${settingsUri}.pending`;
  const backupUri = `${settingsUri}.backup`;
  const oldSettings = JSON.stringify({
    schemaVersion: 2,
    defaultMetadataPolicy: "strip",
    draftThumbnailDisplay: "square",
  });
  const newSettings = JSON.stringify({
    schemaVersion: 2,
    defaultMetadataPolicy: "retain-basic",
    draftThumbnailDisplay: "original",
  });

  beforeEach(() => {
    mockContents.clear();
    mockEvents.length = 0;
    mockFailWriteUri = null;
    mockFailMoveSources.clear();
    mockFailAfterMoveSources.clear();
    mockFailDeleteUris.clear();
  });

  it("preserves the committed settings file when preparing its replacement fails", async () => {
    mockContents.set(settingsUri, oldSettings);
    mockFailWriteUri = pendingUri;

    await expect(expoAppSettingsFileAdapter.writeText(settingsUri, newSettings)).rejects.toThrow(
      "write failed",
    );

    expect(mockContents.get(settingsUri)).toBe(oldSettings);
    expect(mockContents.has(pendingUri)).toBe(false);
    expect(mockEvents).not.toContain(`write ${settingsUri}`);
  });

  it("recovers the committed settings when installing the pending file fails", async () => {
    mockContents.set(settingsUri, oldSettings);
    mockFailMoveSources.add(pendingUri);

    await expect(expoAppSettingsFileAdapter.writeText(settingsUri, newSettings)).rejects.toThrow(
      "move failed",
    );

    expect(mockContents.get(settingsUri)).toBe(oldSettings);
    expect(mockContents.has(pendingUri)).toBe(false);
    expect(mockContents.has(backupUri)).toBe(false);
  });

  it("[F09-S06] reads the backup when an interrupted replacement leaves the primary missing", async () => {
    mockContents.set(backupUri, oldSettings);
    mockContents.set(pendingUri, newSettings);

    await expect(expoAppSettingsFileAdapter.exists(settingsUri)).resolves.toBe(true);
    await expect(expoAppSettingsFileAdapter.readText(settingsUri)).resolves.toBe(oldSettings);
    expect(mockContents.get(settingsUri)).toBe(oldSettings);
    expect(mockContents.has(backupUri)).toBe(false);
    expect(mockContents.has(pendingUri)).toBe(false);
  });

  it("leaves schema validation of a complete JSON object to the settings module", async () => {
    const unsupportedSettings = '{"schemaVersion":99}';
    mockContents.set(settingsUri, unsupportedSettings);

    await expect(expoAppSettingsFileAdapter.exists(settingsUri)).resolves.toBe(true);
    await expect(expoAppSettingsFileAdapter.readText(settingsUri)).resolves.toBe(
      unsupportedSettings,
    );
  });

  it("keeps the backup recoverable when restoring the primary also fails", async () => {
    mockContents.set(settingsUri, oldSettings);
    mockFailMoveSources.add(pendingUri);
    mockFailMoveSources.add(backupUri);

    await expect(expoAppSettingsFileAdapter.writeText(settingsUri, newSettings)).rejects.toThrow(
      "move failed",
    );

    expect(mockContents.has(settingsUri)).toBe(false);
    expect(mockContents.get(backupUri)).toBe(oldSettings);
    expect(mockContents.get(pendingUri)).toBe(newSettings);
    mockFailMoveSources.clear();
    await expect(expoAppSettingsFileAdapter.exists(settingsUri)).resolves.toBe(true);
    await expect(expoAppSettingsFileAdapter.readText(settingsUri)).resolves.toBe(oldSettings);
  });

  it("does not fail a committed update when stale backup cleanup fails", async () => {
    mockContents.set(settingsUri, oldSettings);
    mockFailDeleteUris.add(backupUri);

    await expect(
      expoAppSettingsFileAdapter.writeText(settingsUri, newSettings),
    ).resolves.toBeUndefined();

    expect(mockContents.get(settingsUri)).toBe(newSettings);
    expect(mockContents.get(backupUri)).toBe(oldSettings);
  });

  it("accepts a verified replacement when move reports failure after completing", async () => {
    mockContents.set(settingsUri, oldSettings);
    mockFailAfterMoveSources.add(pendingUri);

    await expect(
      expoAppSettingsFileAdapter.writeText(settingsUri, newSettings),
    ).resolves.toBeUndefined();

    expect(mockContents.get(settingsUri)).toBe(newSettings);
    expect(mockContents.has(pendingUri)).toBe(false);
    expect(mockContents.has(backupUri)).toBe(false);
  });

  it("[F09-S06] replaces settings only after the complete pending file is written", async () => {
    mockContents.set(settingsUri, oldSettings);

    await expoAppSettingsFileAdapter.writeText(settingsUri, newSettings);

    expect(mockContents.get(settingsUri)).toBe(newSettings);
    expect(mockContents.has(pendingUri)).toBe(false);
    expect(mockContents.has(backupUri)).toBe(false);
    expect(mockEvents).toEqual([
      `create ${pendingUri}`,
      `write ${pendingUri}`,
      `move ${settingsUri} -> ${backupUri}`,
      `move ${pendingUri} -> ${settingsUri}`,
      `delete ${backupUri}`,
    ]);
  });
});
