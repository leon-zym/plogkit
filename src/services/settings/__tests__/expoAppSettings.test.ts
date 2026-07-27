import { expoAppSettingsFileAdapter } from "../expoAppSettings";

const mockContents = new Map<string, string>();
const mockEvents: string[] = [];
let mockFailWriteUri: string | null = null;

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
      mockContents.delete(this.uri);
    }

    write(content: string): void {
      mockEvents.push(`write ${this.uri}`);
      if (mockFailWriteUri === this.uri) throw new Error("write failed");
      mockContents.set(this.uri, content);
    }

    async move(destination: MockFile): Promise<void> {
      mockEvents.push(`move ${this.uri} -> ${destination.uri}`);
      const content = mockContents.get(this.uri);
      if (content === undefined) throw new Error(`missing ${this.uri}`);
      mockContents.delete(this.uri);
      mockContents.set(destination.uri, content);
      this.uri = destination.uri;
    }
  }

  return {
    File: MockFile,
    Paths: { document: "memory://documents" },
  };
});

describe("Expo App Settings file adapter", () => {
  const settingsUri = "memory://documents/settings.json";
  const temporaryUri = `${settingsUri}.pending`;

  beforeEach(() => {
    mockContents.clear();
    mockEvents.length = 0;
    mockFailWriteUri = null;
  });

  it("preserves the committed settings file when preparing its replacement fails", async () => {
    mockContents.set(settingsUri, "old settings");
    mockFailWriteUri = temporaryUri;

    await expect(
      expoAppSettingsFileAdapter.writeText(settingsUri, "new settings"),
    ).rejects.toThrow("write failed");

    expect(mockContents.get(settingsUri)).toBe("old settings");
    expect(mockContents.has(temporaryUri)).toBe(false);
    expect(mockEvents).not.toContain(`write ${settingsUri}`);
  });

  it("replaces settings only after the complete pending file is written", async () => {
    mockContents.set(settingsUri, "old settings");

    await expoAppSettingsFileAdapter.writeText(settingsUri, "new settings");

    expect(mockContents.get(settingsUri)).toBe("new settings");
    expect(mockContents.has(temporaryUri)).toBe(false);
    expect(mockEvents).toEqual([
      `create ${temporaryUri}`,
      `write ${temporaryUri}`,
      `move ${temporaryUri} -> ${settingsUri}`,
    ]);
  });
});
