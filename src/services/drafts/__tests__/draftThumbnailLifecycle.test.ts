import { createDocument } from "@/core/document";

import {
  DRAFT_THUMBNAIL_PROFILE,
  draftId,
  type DraftId,
  type DraftLibraryFileAdapter,
  type DraftThumbnailAdapter,
  type DraftThumbnailPair,
} from "../draftLibrary";
import {
  createDraftThumbnailLifecycle,
  type DraftThumbnailAttemptSettlement,
  type DraftThumbnailLifecycleHost,
} from "../draftThumbnailLifecycle";

class MemoryThumbnailFiles implements DraftLibraryFileAdapter {
  readonly files = new Map<string, string | Uint8Array>();
  readonly removals: string[] = [];
  failFileExistsUri: string | null = null;
  failReadTextUri: string | null = null;
  failListFilesUri: string | null = null;

  async fileExists(uri: string): Promise<boolean> {
    if (uri === this.failFileExistsUri) throw new Error("file probe unavailable");
    return this.files.has(uri);
  }

  async directoryExists(): Promise<boolean> {
    return true;
  }

  async ensureDirectory(): Promise<void> {}

  async readText(uri: string): Promise<string> {
    if (uri === this.failReadTextUri) throw new Error("text read unavailable");
    const value = this.files.get(uri);
    if (typeof value !== "string") throw new Error(`missing text ${uri}`);
    return value;
  }

  async writeText(uri: string, content: string): Promise<void> {
    this.files.set(uri, content);
  }

  async copy(sourceUri: string, destinationUri: string): Promise<void> {
    const value = this.files.get(sourceUri);
    if (value === undefined) throw new Error(`missing ${sourceUri}`);
    this.files.set(destinationUri, value);
  }

  async moveFile(sourceUri: string, destinationUri: string): Promise<void> {
    const value = this.files.get(sourceUri);
    if (value === undefined) throw new Error(`missing ${sourceUri}`);
    if (this.files.has(destinationUri)) throw new Error(`destination exists ${destinationUri}`);
    this.files.delete(sourceUri);
    this.files.set(destinationUri, value);
  }

  async moveDirectory(): Promise<void> {
    throw new Error("not implemented");
  }

  async removeFile(uri: string): Promise<void> {
    this.removals.push(uri);
    this.files.delete(uri);
  }

  async removeDirectory(): Promise<void> {}

  async listDirectories(): Promise<readonly string[]> {
    return [];
  }

  async listFiles(uri: string): Promise<readonly string[]> {
    if (uri === this.failListFilesUri) throw new Error("directory listing unavailable");
    const prefix = `${uri.replace(/\/$/, "")}/`;
    return [...this.files.keys()].filter((candidate) => {
      if (!candidate.startsWith(prefix)) return false;
      const relative = candidate.slice(prefix.length);
      return relative.length > 0 && !relative.includes("/");
    });
  }
}

const ID = draftId("draft:thumbnail-lifecycle");
const DRAFT_URI = "memory://library/drafts/draft-thumbnail-lifecycle";
const THUMBNAILS_URI = `${DRAFT_URI}/thumbnails`;
const PAIR_URI = `${DRAFT_URI}/thumbnail-pair.json`;
const SQUARE_SIZE = { width: 360, height: 360 } as const;
const ORIGINAL_SIZE = { width: 720, height: 540 } as const;
const SOURCE = {
  document: createDocument(),
  assets: Object.freeze({ entries: Object.freeze([]), resolve: () => null }),
};

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function pairRecord(
  id: DraftId,
  contentRevision: number,
  squareFile: string,
  originalFile: string,
): string {
  return JSON.stringify({
    thumbnailPairSchemaVersion: 1,
    draftId: id,
    contentRevision,
    profileVersion: DRAFT_THUMBNAIL_PROFILE.profileVersion,
    squareFile,
    originalFile,
    square: SQUARE_SIZE,
    original: ORIGINAL_SIZE,
  });
}

function setup() {
  const files = new MemoryThumbnailFiles();
  const sizes = new Map<string, { readonly width: number; readonly height: number }>();
  const settlements: DraftThumbnailAttemptSettlement[] = [];
  let generationSequence = 0;
  let captureAllowed = true;
  let commitAllowed = true;
  let failAttemptObserver = false;
  let generate: DraftThumbnailAdapter["generate"] = async (input) => {
    files.files.set(input.squareUri, Uint8Array.from([7, input.contentRevision]));
    files.files.set(input.originalUri, Uint8Array.from([8, input.contentRevision]));
    sizes.set(input.squareUri, SQUARE_SIZE);
    sizes.set(input.originalUri, ORIGINAL_SIZE);
    return { square: SQUARE_SIZE, original: ORIGINAL_SIZE };
  };
  const thumbnails: DraftThumbnailAdapter = {
    generate: (input) => generate(input),
    inspect: async (uri) => (files.files.has(uri) ? (sizes.get(uri) ?? null) : null),
  };
  const host: DraftThumbnailLifecycleHost = {
    capture: async () => (captureAllowed ? SOURCE : null),
    commitPairIfCurrent: async (_id, _revision, commitPair) => {
      if (!commitAllowed) return { status: "stale" };
      const pair = await commitPair();
      settlements.push({
        draftId: _id,
        contentRevision: _revision,
        status: "committed",
        pair,
      });
      return { status: "committed" };
    },
    onAttemptFailed: (failure) => {
      settlements.push(failure);
      if (failAttemptObserver) throw new Error("attempt observer failed");
    },
  };
  const lifecycle = createDraftThumbnailLifecycle({
    files,
    thumbnails,
    profile: DRAFT_THUMBNAIL_PROFILE,
    draftUriFor: (id) => (id === ID ? DRAFT_URI : `${DRAFT_URI}-other`),
    createGenerationId: () => `generation-${++generationSequence}`,
    host,
  });

  const seedPair = (
    contentRevision: number,
    location: "current" | "backup" = "current",
  ): DraftThumbnailPair => {
    const squareFile = `seed-r${contentRevision}-square.jpg`;
    const originalFile = `seed-r${contentRevision}-original.jpg`;
    const squareUri = `${THUMBNAILS_URI}/${squareFile}`;
    const originalUri = `${THUMBNAILS_URI}/${originalFile}`;
    files.files.set(
      location === "current" ? PAIR_URI : `${PAIR_URI}.backup`,
      pairRecord(ID, contentRevision, squareFile, originalFile),
    );
    files.files.set(squareUri, Uint8Array.from([1]));
    files.files.set(originalUri, Uint8Array.from([2]));
    sizes.set(squareUri, SQUARE_SIZE);
    sizes.set(originalUri, ORIGINAL_SIZE);
    return {
      contentRevision,
      profileVersion: DRAFT_THUMBNAIL_PROFILE.profileVersion,
      squareUri,
      originalUri,
    };
  };

  return {
    files,
    lifecycle,
    settlements,
    sizes,
    seedPair,
    setCaptureAllowed: (allowed: boolean) => {
      captureAllowed = allowed;
    },
    setCommitAllowed: (allowed: boolean) => {
      commitAllowed = allowed;
    },
    setFailAttemptObserver: (failed: boolean) => {
      failAttemptObserver = failed;
    },
    setGenerate: (next: DraftThumbnailAdapter["generate"]) => {
      generate = next;
    },
  };
}

describe("Draft Thumbnail Lifecycle", () => {
  it("runs once per revision and keeps only the latest pending revision", async () => {
    const { files, lifecycle, settlements, sizes, setGenerate } = setup();
    const firstGate = deferred();
    const generatedRevisions: number[] = [];
    setGenerate(async (input) => {
      generatedRevisions.push(input.contentRevision);
      if (input.contentRevision === 1) await firstGate.promise;
      files.files.set(input.squareUri, Uint8Array.from([7]));
      files.files.set(input.originalUri, Uint8Array.from([8]));
      sizes.set(input.squareUri, SQUARE_SIZE);
      sizes.set(input.originalUri, ORIGINAL_SIZE);
      return { square: SQUARE_SIZE, original: ORIGINAL_SIZE };
    });

    expect(lifecycle.request(ID, 1)).toBe(true);
    expect(lifecycle.request(ID, 1)).toBe(false);
    expect(lifecycle.request(ID, 2)).toBe(true);
    expect(lifecycle.request(ID, 3)).toBe(true);
    expect(lifecycle.request(ID, 2)).toBe(false);
    await waitFor(() => generatedRevisions.length === 1, "first generation");

    firstGate.resolve();
    await waitFor(() => settlements.length === 2, "running and pending settlements");

    expect(generatedRevisions).toEqual([1, 3]);
    expect(settlements).toEqual([
      expect.objectContaining({ contentRevision: 1, status: "committed" }),
      expect.objectContaining({ contentRevision: 3, status: "committed" }),
    ]);
    expect(lifecycle.request(ID, 1)).toBe(false);
    expect(lifecycle.request(ID, 3)).toBe(false);
  });

  it("does not serialize thumbnail generation for different Drafts", async () => {
    const { files, lifecycle, settlements, setGenerate, sizes } = setup();
    const otherId = draftId("draft:other-thumbnail-lifecycle");
    const firstStarted = deferred();
    const releaseFirst = deferred();
    setGenerate(async (input) => {
      if (input.draftId === ID) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      files.files.set(input.squareUri, Uint8Array.from([7]));
      files.files.set(input.originalUri, Uint8Array.from([8]));
      sizes.set(input.squareUri, SQUARE_SIZE);
      sizes.set(input.originalUri, ORIGINAL_SIZE);
      return { square: SQUARE_SIZE, original: ORIGINAL_SIZE };
    });

    expect(lifecycle.request(ID, 1)).toBe(true);
    await firstStarted.promise;
    expect(lifecycle.request(otherId, 1)).toBe(true);
    await waitFor(
      () =>
        settlements.some(
          (settlement) => settlement.draftId === otherId && settlement.status === "committed",
        ),
      "other Draft settlement",
    );
    expect(
      settlements.some(
        (settlement) => settlement.draftId === ID && settlement.status === "committed",
      ),
    ).toBe(false);

    releaseFirst.resolve();
    await waitFor(
      () =>
        settlements.some(
          (settlement) => settlement.draftId === ID && settlement.status === "committed",
        ),
      "first Draft settlement",
    );
  });

  it("continues with the newest pending revision when a failure observer throws", async () => {
    const { files, lifecycle, settlements, setFailAttemptObserver, setGenerate, sizes } = setup();
    setFailAttemptObserver(true);
    setGenerate(async (input) => {
      if (input.contentRevision === 1) throw new Error("render failed");
      files.files.set(input.squareUri, Uint8Array.from([7]));
      files.files.set(input.originalUri, Uint8Array.from([8]));
      sizes.set(input.squareUri, SQUARE_SIZE);
      sizes.set(input.originalUri, ORIGINAL_SIZE);
      return { square: SQUARE_SIZE, original: ORIGINAL_SIZE };
    });

    expect(lifecycle.request(ID, 1)).toBe(true);
    expect(lifecycle.request(ID, 2)).toBe(true);
    await waitFor(() => settlements.length === 2, "failure and pending success");

    expect(settlements).toEqual([
      { draftId: ID, contentRevision: 1, status: "failed" },
      expect.objectContaining({ draftId: ID, contentRevision: 2, status: "committed" }),
    ]);
  });

  it("publishes no pair when either capture or final commit guard rejects the Draft", async () => {
    const beforeGeneration = setup();
    beforeGeneration.setCaptureAllowed(false);

    expect(beforeGeneration.lifecycle.request(ID, 1)).toBe(true);
    await waitFor(() => beforeGeneration.settlements.length === 1, "capture rejection settlement");
    expect(beforeGeneration.settlements).toEqual([
      { draftId: ID, contentRevision: 1, status: "failed" },
    ]);
    expect(beforeGeneration.files.files.has(PAIR_URI)).toBe(false);

    const beforeCommit = setup();
    beforeCommit.setCommitAllowed(false);

    expect(beforeCommit.lifecycle.request(ID, 2)).toBe(true);
    await waitFor(() => beforeCommit.settlements.length === 1, "commit rejection settlement");
    expect(beforeCommit.settlements).toEqual([
      { draftId: ID, contentRevision: 2, status: "failed" },
    ]);
    expect(beforeCommit.files.files.has(PAIR_URI)).toBe(false);
    await expect(beforeCommit.lifecycle.inspect(ID, 2)).resolves.toBeNull();
  });

  it("retains both active generation paths while maintenance removes unrelated orphans", async () => {
    const { files, lifecycle, settlements, seedPair, sizes, setGenerate } = setup();
    const committed = seedPair(3);
    const squareWritten = deferred();
    const originalGate = deferred();
    let activeSquareUri = "";
    setGenerate(async (input) => {
      activeSquareUri = input.squareUri;
      files.files.set(input.squareUri, Uint8Array.from([7]));
      sizes.set(input.squareUri, SQUARE_SIZE);
      squareWritten.resolve();
      await originalGate.promise;
      files.files.set(input.originalUri, Uint8Array.from([8]));
      sizes.set(input.originalUri, ORIGINAL_SIZE);
      return { square: SQUARE_SIZE, original: ORIGINAL_SIZE };
    });

    expect(lifecycle.request(ID, 4)).toBe(true);
    await squareWritten.promise;
    const orphanUri = `${THUMBNAILS_URI}/interrupted.jpg`;
    files.files.set(orphanUri, Uint8Array.from([9]));

    await lifecycle.maintain(ID, 4);

    expect(files.files.has(activeSquareUri)).toBe(true);
    expect(files.files.has(committed.squareUri)).toBe(true);
    expect(files.files.has(committed.originalUri)).toBe(true);
    expect(files.files.has(orphanUri)).toBe(false);
    originalGate.resolve();
    await waitFor(() => settlements.length === 1, "active pair settlement");
    await expect(lifecycle.inspect(ID, 4)).resolves.toMatchObject({
      contentRevision: 4,
      profileVersion: DRAFT_THUMBNAIL_PROFILE.profileVersion,
    });

    await lifecycle.maintain(ID, 4);
    expect(files.files.has(committed.squareUri)).toBe(false);
    expect(files.files.has(committed.originalUri)).toBe(false);
    const current = await lifecycle.inspect(ID, 4);
    expect(current).not.toBeNull();
    expect(files.files.has(current?.squareUri ?? "")).toBe(true);
    expect(files.files.has(current?.originalUri ?? "")).toBe(true);
  });

  it("performs no deletion when pair facts or thumbnail enumeration are unknown", async () => {
    for (const fault of ["pair-probe", "pair-read", "listing"] as const) {
      const { files, lifecycle, seedPair } = setup();
      const orphanUri = `${THUMBNAILS_URI}/${fault}-orphan.jpg`;
      files.files.set(orphanUri, Uint8Array.from([9]));
      if (fault === "pair-probe") files.failFileExistsUri = PAIR_URI;
      if (fault === "pair-read") {
        seedPair(1);
        files.failReadTextUri = PAIR_URI;
      }
      if (fault === "listing") files.failListFilesUri = THUMBNAILS_URI;

      await lifecycle.maintain(ID, 1);

      expect(files.files.has(orphanUri)).toBe(true);
      expect(files.removals).not.toContain(orphanUri);
    }
  });

  it("performs no deletion when the committed pair is newer than the recovered Draft", async () => {
    const { files, lifecycle, seedPair } = setup();
    const future = seedPair(5);
    const orphanUri = `${THUMBNAILS_URI}/future-orphan.jpg`;
    files.files.set(orphanUri, Uint8Array.from([9]));

    await lifecycle.maintain(ID, 4);

    expect(files.files.has(future.squareUri)).toBe(true);
    expect(files.files.has(future.originalUri)).toBe(true);
    expect(files.files.has(orphanUri)).toBe(true);
    expect(files.removals).not.toContain(orphanUri);
  });

  it("recovers a valid old pair and keeps it when a newer generated pair fails validation", async () => {
    const { files, lifecycle, settlements, seedPair, setGenerate, sizes } = setup();
    const oldPair = seedPair(1, "backup");
    files.files.set(PAIR_URI, "not-json");

    await expect(lifecycle.inspect(ID, 2)).resolves.toEqual(oldPair);
    expect(files.files.has(`${PAIR_URI}.backup`)).toBe(false);
    setGenerate(async (input) => {
      const invalidSquare = { width: 359, height: 360 } as const;
      files.files.set(input.squareUri, Uint8Array.from([7]));
      files.files.set(input.originalUri, Uint8Array.from([8]));
      sizes.set(input.squareUri, invalidSquare);
      sizes.set(input.originalUri, ORIGINAL_SIZE);
      return { square: invalidSquare, original: ORIGINAL_SIZE };
    });

    expect(lifecycle.request(ID, 2)).toBe(true);
    await waitFor(() => settlements.length === 1, "invalid pair settlement");

    expect(settlements).toEqual([{ draftId: ID, contentRevision: 2, status: "failed" }]);
    await expect(lifecycle.inspect(ID, 2)).resolves.toEqual(oldPair);
    expect(JSON.parse(await files.readText(PAIR_URI))).toMatchObject({
      contentRevision: 1,
      squareFile: "seed-r1-square.jpg",
      originalFile: "seed-r1-original.jpg",
    });
  });
});
