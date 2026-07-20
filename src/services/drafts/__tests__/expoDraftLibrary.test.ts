import { draftId } from "../draftLibrary";
import { createExpoDraftRuntimeStorage } from "../expoDraftLibrary";

const mockContents = new Map<string, string>();
const mockDirectories = new Set<string>();
let mockFailMoveAfterDestinationRemovalTo: string | null = null;

function mockUri(parent: string | { readonly uri: string }, name?: string): string {
  const base = typeof parent === "string" ? parent : parent.uri;
  return name === undefined ? base : `${base.replace(/\/$/, "")}/${name}`;
}

jest.mock("expo-file-system", () => {
  class MockDirectory {
    uri: string;

    constructor(parent: string | { readonly uri: string }, name?: string) {
      this.uri = mockUri(parent, name);
    }

    get exists(): boolean {
      return mockDirectories.has(this.uri);
    }

    create(): void {
      mockDirectories.add(this.uri);
    }

    list(): readonly never[] {
      return [];
    }
  }

  class MockFile {
    uri: string;

    constructor(parent: string | { readonly uri: string }, name?: string) {
      this.uri = mockUri(parent, name);
    }

    get exists(): boolean {
      return mockContents.has(this.uri);
    }

    create(): void {
      mockContents.set(this.uri, "");
    }

    write(content: string): void {
      mockContents.set(this.uri, content);
    }

    async text(): Promise<string> {
      const content = mockContents.get(this.uri);
      if (content === undefined) throw new Error(`missing ${this.uri}`);
      return content;
    }

    async move(destination: MockFile): Promise<void> {
      if (this.uri === destination.uri) throw new Error("cannot move a file onto itself");
      const content = mockContents.get(this.uri);
      if (content === undefined) throw new Error(`missing ${this.uri}`);
      if (mockFailMoveAfterDestinationRemovalTo === destination.uri) {
        mockContents.delete(destination.uri);
        throw new Error("move failed after destination removal");
      }
      mockContents.delete(this.uri);
      mockContents.set(destination.uri, content);
      this.uri = destination.uri;
    }
  }

  return {
    Directory: MockDirectory,
    File: MockFile,
    Paths: { document: "memory://documents" },
  };
});

jest.mock("../../image-import/skiaPreviewGenerator", () => ({
  createSkiaPreviewGenerator: () => ({
    generate: jest.fn(),
    isValid: jest.fn(),
  }),
}));

describe("Expo Draft runtime storage", () => {
  beforeEach(() => {
    mockContents.clear();
    mockDirectories.clear();
    mockFailMoveAfterDestinationRemovalTo = null;
  });

  it("atomically replaces the recent Draft locator more than once", async () => {
    const storage = createExpoDraftRuntimeStorage();

    await storage.writeRecentDraftId(draftId("first"));
    await storage.writeRecentDraftId(draftId("second"));

    await expect(storage.readRecentDraftId()).resolves.toBe("second");
  });

  it("recovers the previous recent Draft after replacement removes the destination and fails", async () => {
    const storage = createExpoDraftRuntimeStorage();
    await storage.writeRecentDraftId(draftId("first"));
    mockFailMoveAfterDestinationRemovalTo = "memory://documents/plogkit/recent-draft.json";

    await expect(storage.writeRecentDraftId(draftId("second"))).rejects.toThrow(
      "move failed after destination removal",
    );
    mockFailMoveAfterDestinationRemovalTo = null;

    await expect(createExpoDraftRuntimeStorage().readRecentDraftId()).resolves.toBe("first");
  });
});
