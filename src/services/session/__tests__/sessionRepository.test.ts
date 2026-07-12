import { createEmptyDocument, DOCUMENT_SCHEMA_VERSION } from "@/core/document";
import { setBackgroundColor } from "@/core/operations";

import {
  createSessionRepository,
  type SessionFileAdapter,
  type SessionPaths,
} from "../sessionRepository";

const paths: SessionPaths = {
  currentDirectoryUri: "memory://projects/current",
  assetsDirectoryUri: "memory://projects/current/assets",
  previewsDirectoryUri: "memory://projects/current/previews",
  backupDirectoryUri: "memory://projects/current/backup",
  documentUri: "memory://projects/current/document.json",
  temporaryDocumentUri: "memory://projects/current/document.json.tmp",
};

class MemoryFiles implements SessionFileAdapter {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  readonly moves: { source: string; destination: string }[] = [];

  async exists(uri: string): Promise<boolean> {
    return this.files.has(uri);
  }

  async ensureDirectory(uri: string): Promise<void> {
    this.directories.add(uri);
  }

  async readText(uri: string): Promise<string> {
    const value = this.files.get(uri);
    if (value === undefined) throw new Error(`missing ${uri}`);
    return value;
  }

  async writeText(uri: string, content: string): Promise<void> {
    this.files.set(uri, content);
  }

  async move(source: string, destination: string): Promise<void> {
    const content = this.files.get(source);
    if (content === undefined) throw new Error(`missing ${source}`);
    this.files.delete(source);
    this.files.set(destination, content);
    this.moves.push({ source, destination });
  }
}

describe("current session repository", () => {
  it("reports that no session exists", async () => {
    const repository = createSessionRepository({ files: new MemoryFiles(), paths });

    await expect(repository.restore()).resolves.toEqual({ status: "none" });
  });

  it("atomically saves and restores the current document", async () => {
    const files = new MemoryFiles();
    const repository = createSessionRepository({ files, paths });
    const document = setBackgroundColor(createEmptyDocument(), "#112233");

    await repository.save(document);
    const restored = await repository.restore();

    expect(restored).toEqual({ status: "restored", document });
    expect(files.directories).toEqual(
      new Set([paths.currentDirectoryUri, paths.assetsDirectoryUri, paths.previewsDirectoryUri]),
    );
    expect(files.moves).toContainEqual({
      source: paths.temporaryDocumentUri,
      destination: paths.documentUri,
    });
  });

  it.each([
    ["corrupt", "not json"],
    ["future-schema", JSON.stringify({ schemaVersion: DOCUMENT_SCHEMA_VERSION + 1 })],
  ] as const)("backs up a %s document and returns a new session", async (reason, content) => {
    const files = new MemoryFiles();
    files.files.set(paths.documentUri, content);
    const repository = createSessionRepository({ files, paths, now: () => 1234 });

    const result = await repository.restore();

    expect(result).toEqual({
      status: "recovery-failed",
      reason,
      document: createEmptyDocument(),
      backupUri: `${paths.backupDirectoryUri}/document-1234.json`,
    });
    expect(files.moves).toContainEqual({
      source: paths.documentUri,
      destination: `${paths.backupDirectoryUri}/document-1234.json`,
    });
  });
});
