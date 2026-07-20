import {
  recoverFile,
  type RecoverableFileAdapter,
  type RecoverableFileState,
} from "../recoverableFile";

class MemoryFiles implements RecoverableFileAdapter {
  readonly entries = new Map<string, string>();

  async fileExists(uri: string): Promise<boolean> {
    return this.entries.has(uri);
  }

  async moveFile(sourceUri: string, destinationUri: string): Promise<void> {
    const value = this.entries.get(sourceUri);
    if (value === undefined) throw new Error(`missing ${sourceUri}`);
    if (this.entries.has(destinationUri)) throw new Error(`destination exists ${destinationUri}`);
    this.entries.delete(sourceUri);
    this.entries.set(destinationUri, value);
  }

  async removeFile(uri: string): Promise<void> {
    this.entries.delete(uri);
  }
}

const currentUri = "memory://document.json";
const backupUri = `${currentUri}.backup`;
const temporaryUri = `${currentUri}.tmp`;

function state(files: MemoryFiles): RecoverableFileState {
  return {
    currentUri,
    backupUri,
    temporaryUri,
    isValid: async (uri) => {
      const value = files.entries.get(uri);
      return value === "old" || value === "new";
    },
  };
}

describe("recoverFile", () => {
  it.each([
    {
      name: "keeps a valid current over valid sidecars",
      entries: [
        [currentUri, "new"],
        [backupUri, "old"],
        [temporaryUri, "new"],
      ],
      expected: "new",
    },
    {
      name: "restores a valid backup before a valid temporary",
      entries: [
        [currentUri, "broken"],
        [backupUri, "old"],
        [temporaryUri, "new"],
      ],
      expected: "old",
    },
    {
      name: "promotes a valid temporary when no old version survives",
      entries: [
        [backupUri, "broken"],
        [temporaryUri, "new"],
      ],
      expected: "new",
    },
  ])("$name", async ({ entries, expected }) => {
    const files = new MemoryFiles();
    for (const [uri, value] of entries) files.entries.set(uri, value);

    await expect(recoverFile(files, state(files))).resolves.toBe(true);

    expect(files.entries.get(currentUri)).toBe(expected);
    expect(files.entries.has(backupUri)).toBe(false);
    expect(files.entries.has(temporaryUri)).toBe(false);
  });

  it("reports no recovery and removes invalid sidecars when every candidate is invalid", async () => {
    const files = new MemoryFiles();
    files.entries.set(currentUri, "broken");
    files.entries.set(backupUri, "broken");
    files.entries.set(temporaryUri, "broken");

    await expect(recoverFile(files, state(files))).resolves.toBe(false);

    expect(files.entries.get(currentUri)).toBe("broken");
    expect(files.entries.has(backupUri)).toBe(false);
    expect(files.entries.has(temporaryUri)).toBe(false);
  });
});
