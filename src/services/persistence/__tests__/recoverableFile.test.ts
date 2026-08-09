import {
  commitPreparedFileWithOutcome,
  recoverFile,
  type RecoverableFileAdapter,
  type RecoverableFileState,
} from "../recoverableFile";

class MemoryFiles implements RecoverableFileAdapter {
  readonly entries = new Map<string, string>();
  failMoveTo: string | null = null;
  failMoveAfterCopyTo: string | null = null;

  async fileExists(uri: string): Promise<boolean> {
    return this.entries.has(uri);
  }

  async moveFile(sourceUri: string, destinationUri: string): Promise<void> {
    const value = this.entries.get(sourceUri);
    if (value === undefined) throw new Error(`missing ${sourceUri}`);
    if (this.entries.has(destinationUri)) throw new Error(`destination exists ${destinationUri}`);
    if (this.failMoveTo === destinationUri) {
      this.failMoveTo = null;
      throw new Error("move failed");
    }
    if (this.failMoveAfterCopyTo === destinationUri) {
      this.failMoveAfterCopyTo = null;
      this.entries.set(destinationUri, value);
      throw new Error("move copied destination but retained source");
    }
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

describe("commitPreparedFileWithOutcome", () => {
  it("reports committed when recovery confirms the prepared current", async () => {
    const files = new MemoryFiles();
    files.entries.set(currentUri, "old");
    files.entries.set(temporaryUri, "new");
    files.failMoveAfterCopyTo = currentUri;

    await expect(
      commitPreparedFileWithOutcome(
        files,
        state(files),
        async (uri) => files.entries.get(uri) === "new",
      ),
    ).resolves.toEqual({ status: "committed" });
    expect(files.entries.get(currentUri)).toBe("new");
    expect(files.entries.has(backupUri)).toBe(false);
    expect(files.entries.has(temporaryUri)).toBe(false);
  });

  it("[F06-S10][F08-S27] reports not committed when recovery restores the previous current", async () => {
    const files = new MemoryFiles();
    files.entries.set(currentUri, "old");
    files.entries.set(temporaryUri, "new");
    files.failMoveTo = currentUri;

    const outcome = await commitPreparedFileWithOutcome(
      files,
      state(files),
      async (uri) => files.entries.get(uri) === "new",
    );

    expect(outcome).toMatchObject({ status: "not-committed" });
    expect(files.entries.get(currentUri)).toBe("old");
    expect(files.entries.has(backupUri)).toBe(false);
    expect(files.entries.has(temporaryUri)).toBe(false);
  });

  it("reports unknown and preserves candidates when recovery cannot classify the result", async () => {
    const files = new MemoryFiles();
    files.entries.set(currentUri, "old");
    files.entries.set(temporaryUri, "new");
    files.failMoveAfterCopyTo = currentUri;
    const uncertainState: RecoverableFileState = {
      ...state(files),
      isValid: async () => {
        throw new Error("validation unavailable");
      },
    };

    const outcome = await commitPreparedFileWithOutcome(
      files,
      uncertainState,
      async (uri) => files.entries.get(uri) === "new",
    );

    expect(outcome).toMatchObject({ status: "unknown" });
    expect(files.entries.get(currentUri)).toBe("new");
    expect(files.entries.get(backupUri)).toBe("old");
    expect(files.entries.get(temporaryUri)).toBe("new");
  });
});
