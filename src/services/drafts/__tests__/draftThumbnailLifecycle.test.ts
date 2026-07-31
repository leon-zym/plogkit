import { createDocument } from "@/core/document";

import {
  DRAFT_THUMBNAIL_PROFILE,
  draftId,
  type DraftThumbnailAdapter,
  type DraftThumbnailPair,
} from "../draftLibrary";
import {
  createDraftThumbnailLifecycle,
  type DraftThumbnailAttemptSettlement,
  type DraftThumbnailFileAdapter,
  type DraftThumbnailLifecycleHost,
} from "../draftThumbnailLifecycle";

class MemoryThumbnailFiles implements DraftThumbnailFileAdapter {
  readonly files = new Map<string, string | Uint8Array>();
  readonly removals: string[] = [];
  failFileExistsUri: string | null = null;
  failReadTextUri: string | null = null;
  failListFilesUri: string | null = null;
  beforeListFiles: ((uri: string) => Promise<void>) | null = null;
  private interrupted = false;
  private moveInterruption: {
    readonly destinationUri: string;
    readonly timing: "before" | "after-copy" | "after";
  } | null = null;

  private assertAvailable(): void {
    if (this.interrupted) throw new Error("storage interrupted");
  }

  interruptMove(destinationUri: string, timing: "before" | "after-copy" | "after"): void {
    this.moveInterruption = { destinationUri, timing };
  }

  resumeStorage(): void {
    this.interrupted = false;
    this.moveInterruption = null;
  }

  async fileExists(uri: string): Promise<boolean> {
    this.assertAvailable();
    if (uri === this.failFileExistsUri) throw new Error("file probe unavailable");
    return this.files.has(uri);
  }

  async readText(uri: string): Promise<string> {
    this.assertAvailable();
    if (uri === this.failReadTextUri) throw new Error("text read unavailable");
    const value = this.files.get(uri);
    if (typeof value !== "string") throw new Error(`missing text ${uri}`);
    return value;
  }

  async writeText(uri: string, content: string): Promise<void> {
    this.assertAvailable();
    this.files.set(uri, content);
  }

  async moveFile(sourceUri: string, destinationUri: string): Promise<void> {
    this.assertAvailable();
    const interruption =
      this.moveInterruption?.destinationUri === destinationUri ? this.moveInterruption : null;
    if (interruption?.timing === "before") {
      this.interrupted = true;
      throw new Error("process interrupted before move");
    }
    const value = this.files.get(sourceUri);
    if (value === undefined) throw new Error(`missing ${sourceUri}`);
    if (this.files.has(destinationUri)) throw new Error(`destination exists ${destinationUri}`);
    if (interruption?.timing === "after-copy") {
      this.files.set(destinationUri, value);
      this.interrupted = true;
      throw new Error("process interrupted after move copied its destination");
    }
    this.files.delete(sourceUri);
    this.files.set(destinationUri, value);
    if (interruption?.timing === "after") {
      this.interrupted = true;
      throw new Error("process interrupted after move");
    }
  }

  async removeFile(uri: string): Promise<void> {
    this.assertAvailable();
    this.removals.push(uri);
    this.files.delete(uri);
  }

  async listFiles(uri: string): Promise<readonly string[]> {
    this.assertAvailable();
    if (uri === this.failListFilesUri) throw new Error("directory listing unavailable");
    await this.beforeListFiles?.(uri);
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
  id: string,
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

function storedPairRevision(files: MemoryThumbnailFiles, uri: string): number | null {
  const value = files.files.get(uri);
  if (typeof value !== "string") return null;
  return (JSON.parse(value) as { readonly contentRevision: number }).contentRevision;
}

function setup() {
  const files = new MemoryThumbnailFiles();
  const sizes = new Map<string, { readonly width: number; readonly height: number }>();
  const settlements: DraftThumbnailAttemptSettlement[] = [];
  let generationSequence = 0;
  let createGenerationId = () => `generation-${++generationSequence}`;
  let captureAllowed = true;
  let commitMode: "committed" | "stale" | "throw-after-commit" = "committed";
  let commitCallbackCalls = 0;
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
    commitPairIfCurrent: async (_id, _revision, _source, commitPair) => {
      if (commitMode === "stale") return { status: "stale" };
      commitCallbackCalls += 1;
      const pair = await commitPair();
      if (commitMode === "throw-after-commit") {
        throw new Error("commit outcome unavailable");
      }
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
    cleanupDiscardedGeneration: async () => {},
  };
  const createLifecycle = () =>
    createDraftThumbnailLifecycle({
      files,
      thumbnails,
      profile: DRAFT_THUMBNAIL_PROFILE,
      draftUriFor: (id) => (id === ID ? DRAFT_URI : `${DRAFT_URI}-other`),
      createGenerationId: () => createGenerationId(),
      host,
    });
  const lifecycle = createLifecycle();

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
    restartLifecycle: createLifecycle,
    settlements,
    sizes,
    seedPair,
    setCaptureAllowed: (allowed: boolean) => {
      captureAllowed = allowed;
    },
    setCommitAllowed: (allowed: boolean) => {
      commitMode = allowed ? "committed" : "stale";
    },
    setCommitMode: (mode: "committed" | "stale" | "throw-after-commit") => {
      commitMode = mode;
    },
    getCommitCallbackCalls: () => commitCallbackCalls,
    setCreateGenerationId: (next: () => string) => {
      createGenerationId = next;
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

    expect(lifecycle.request(ID, 1)).toBe("scheduled");
    expect(lifecycle.request(ID, 1)).toBe("in-progress");
    expect(lifecycle.request(ID, 2)).toBe("scheduled");
    expect(lifecycle.request(ID, 3)).toBe("scheduled");
    expect(lifecycle.request(ID, 2)).toBe("already-attempted");
    await waitFor(() => generatedRevisions.length === 1, "first generation");

    firstGate.resolve();
    await waitFor(() => settlements.length === 2, "running and pending settlements");

    expect(generatedRevisions).toEqual([1, 3]);
    expect(settlements).toEqual([
      expect.objectContaining({ contentRevision: 1, status: "committed" }),
      expect.objectContaining({ contentRevision: 3, status: "committed" }),
    ]);
    const committedPairs = settlements.flatMap((settlement) =>
      settlement.status === "committed" ? [settlement.pair] : [],
    );
    expect(committedPairs[0]?.squareUri).toContain("/r1-p1-");
    expect(committedPairs[0]?.originalUri).toContain("/r1-p1-");
    expect(committedPairs[1]?.squareUri).toContain("/r3-p1-");
    expect(committedPairs[1]?.originalUri).toContain("/r3-p1-");
    expect(lifecycle.request(ID, 1)).toBe("already-attempted");
    expect(lifecycle.request(ID, 3)).toBe("already-attempted");
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

    expect(lifecycle.request(ID, 1)).toBe("scheduled");
    await firstStarted.promise;
    expect(lifecycle.request(otherId, 1)).toBe("scheduled");
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

    expect(lifecycle.request(ID, 1)).toBe("scheduled");
    expect(lifecycle.request(ID, 2)).toBe("scheduled");
    await waitFor(() => settlements.length === 2, "failure and pending success");

    expect(settlements).toEqual([
      { draftId: ID, contentRevision: 1, status: "failed" },
      expect.objectContaining({ draftId: ID, contentRevision: 2, status: "committed" }),
    ]);
  });

  it("publishes no pair when either capture or final commit guard rejects the Draft", async () => {
    const beforeGeneration = setup();
    beforeGeneration.setCaptureAllowed(false);

    expect(beforeGeneration.lifecycle.request(ID, 1)).toBe("scheduled");
    await waitFor(() => beforeGeneration.settlements.length === 1, "capture rejection settlement");
    expect(beforeGeneration.settlements).toEqual([
      { draftId: ID, contentRevision: 1, status: "failed" },
    ]);
    expect(beforeGeneration.files.files.has(PAIR_URI)).toBe(false);

    const beforeCommit = setup();
    beforeCommit.setCommitAllowed(false);

    expect(beforeCommit.lifecycle.request(ID, 2)).toBe("scheduled");
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

    expect(lifecycle.request(ID, 4)).toBe("scheduled");
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

  it("recovers the valid backup when the current pair belongs to no Draft", async () => {
    const { files, lifecycle, seedPair } = setup();
    const backup = seedPair(2, "backup");
    files.files.set(
      PAIR_URI,
      pairRecord("", 1, "unowned-square.jpg", "unowned-original.jpg"),
    );

    await expect(lifecycle.inspect(ID, 2)).resolves.toEqual(backup);
    expect(files.files.has(`${PAIR_URI}.backup`)).toBe(false);
    expect(JSON.parse(await files.readText(PAIR_URI))).toMatchObject({
      draftId: ID,
      contentRevision: 2,
    });
  });

  it("preserves current and backup candidates when reading the current pair is unavailable", async () => {
    const { files, lifecycle, seedPair } = setup();
    const backup = seedPair(1, "backup");
    const current = seedPair(2);
    files.failReadTextUri = PAIR_URI;

    await expect(lifecycle.inspect(ID, 2)).resolves.toBeNull();

    files.failReadTextUri = null;
    expect(JSON.parse(await files.readText(PAIR_URI))).toMatchObject({
      draftId: ID,
      contentRevision: current.contentRevision,
    });
    expect(JSON.parse(await files.readText(`${PAIR_URI}.backup`))).toMatchObject({
      draftId: ID,
      contentRevision: backup.contentRevision,
    });
  });

  it.each([
    {
      label: "before moving current to backup",
      destinationUri: `${PAIR_URI}.backup`,
      timing: "before",
      interruptedState: { current: 1, backup: null, temporary: 2 },
      recoveredRevision: 1,
    },
    {
      label: "after copying current to backup",
      destinationUri: `${PAIR_URI}.backup`,
      timing: "after-copy",
      interruptedState: { current: 1, backup: 1, temporary: 2 },
      recoveredRevision: 1,
    },
    {
      label: "after moving current to backup",
      destinationUri: `${PAIR_URI}.backup`,
      timing: "after",
      interruptedState: { current: null, backup: 1, temporary: 2 },
      recoveredRevision: 1,
    },
    {
      label: "after copying temporary to current",
      destinationUri: PAIR_URI,
      timing: "after-copy",
      interruptedState: { current: 2, backup: 1, temporary: 2 },
      recoveredRevision: 2,
    },
    {
      label: "after moving temporary to current",
      destinationUri: PAIR_URI,
      timing: "after",
      interruptedState: { current: 2, backup: 1, temporary: null },
      recoveredRevision: 2,
    },
  ] as const)(
    "recovers the pair on restart when storage stops $label",
    async ({ destinationUri, timing, interruptedState, recoveredRevision }) => {
      const { files, lifecycle, restartLifecycle, seedPair, settlements } = setup();
      seedPair(1);
      files.interruptMove(destinationUri, timing);

      expect(lifecycle.request(ID, 2)).toBe("scheduled");
      await waitFor(
        () =>
          settlements.some(
            (settlement) => settlement.contentRevision === 2 && settlement.status === "failed",
          ),
        "interrupted pair settlement",
      );
      files.resumeStorage();

      expect({
        current: storedPairRevision(files, PAIR_URI),
        backup: storedPairRevision(files, `${PAIR_URI}.backup`),
        temporary: storedPairRevision(files, `${PAIR_URI}.tmp`),
      }).toEqual(interruptedState);

      await expect(restartLifecycle().inspect(ID, 2)).resolves.toMatchObject({
        contentRevision: recoveredRevision,
        profileVersion: DRAFT_THUMBNAIL_PROFILE.profileVersion,
      });
      expect(storedPairRevision(files, PAIR_URI)).toBe(recoveredRevision);
      expect(files.files.has(`${PAIR_URI}.backup`)).toBe(false);
      expect(files.files.has(`${PAIR_URI}.tmp`)).toBe(false);
    },
  );

  it("promotes the prepared first pair when storage stops before its only move", async () => {
    const { files, lifecycle, restartLifecycle, settlements } = setup();
    files.interruptMove(PAIR_URI, "before");

    expect(lifecycle.request(ID, 1)).toBe("scheduled");
    await waitFor(
      () =>
        settlements.some(
          (settlement) => settlement.contentRevision === 1 && settlement.status === "failed",
        ),
      "interrupted first pair settlement",
    );
    files.resumeStorage();

    expect({
      current: storedPairRevision(files, PAIR_URI),
      backup: storedPairRevision(files, `${PAIR_URI}.backup`),
      temporary: storedPairRevision(files, `${PAIR_URI}.tmp`),
    }).toEqual({ current: null, backup: null, temporary: 1 });

    await expect(restartLifecycle().inspect(ID, 1)).resolves.toMatchObject({
      contentRevision: 1,
      profileVersion: DRAFT_THUMBNAIL_PROFILE.profileVersion,
    });
    expect(storedPairRevision(files, PAIR_URI)).toBe(1);
    expect(files.files.has(`${PAIR_URI}.backup`)).toBe(false);
    expect(files.files.has(`${PAIR_URI}.tmp`)).toBe(false);
  });

  it.each([
    {
      label: "belongs to another Draft",
      currentId: "draft:foreign",
      currentRevision: 2,
      maximumRevision: 2,
      squareExists: true,
      originalExists: true,
    },
    {
      label: "is newer than the recovered Draft",
      currentId: ID,
      currentRevision: 3,
      maximumRevision: 2,
      squareExists: true,
      originalExists: true,
    },
    {
      label: "is missing one representation",
      currentId: ID,
      currentRevision: 2,
      maximumRevision: 2,
      squareExists: true,
      originalExists: false,
    },
  ])(
    "recovers a complete backup when the schema-valid current pair $label",
    async ({
      currentId,
      currentRevision,
      maximumRevision,
      squareExists,
      originalExists,
    }) => {
      const { files, lifecycle, seedPair } = setup();
      const backup = seedPair(1, "backup");
      const squareFile = "invalid-current-square.jpg";
      const originalFile = "invalid-current-original.jpg";
      const squareUri = `${THUMBNAILS_URI}/${squareFile}`;
      const originalUri = `${THUMBNAILS_URI}/${originalFile}`;
      files.files.set(
        PAIR_URI,
        pairRecord(currentId, currentRevision, squareFile, originalFile),
      );
      if (squareExists) files.files.set(squareUri, Uint8Array.from([7]));
      if (originalExists) files.files.set(originalUri, Uint8Array.from([8]));

      await expect(lifecycle.inspect(ID, maximumRevision)).resolves.toEqual(backup);
      expect(files.files.has(`${PAIR_URI}.backup`)).toBe(false);
      expect(JSON.parse(await files.readText(PAIR_URI))).toMatchObject({
        draftId: ID,
        contentRevision: 1,
      });
    },
  );

  it("retains a pending attempt that starts while maintenance is enumerating orphans", async () => {
    const { files, lifecycle, settlements, seedPair, setGenerate, sizes } = setup();
    const committed = seedPair(1);
    const oldStarted = deferred();
    const failOld = deferred();
    const maintenanceReachedListing = deferred();
    const continueMaintenance = deferred();
    const pendingSquareWritten = deferred();
    const finishPending = deferred();
    let pendingSquareUri = "";

    setGenerate(async (input) => {
      if (input.contentRevision === 2) {
        oldStarted.resolve();
        await failOld.promise;
        throw new Error("old generation failed");
      }
      pendingSquareUri = input.squareUri;
      files.files.set(input.squareUri, Uint8Array.from([7]));
      sizes.set(input.squareUri, SQUARE_SIZE);
      pendingSquareWritten.resolve();
      await finishPending.promise;
      files.files.set(input.originalUri, Uint8Array.from([8]));
      sizes.set(input.originalUri, ORIGINAL_SIZE);
      return { square: SQUARE_SIZE, original: ORIGINAL_SIZE };
    });
    files.beforeListFiles = async (uri) => {
      if (uri !== THUMBNAILS_URI) return;
      files.beforeListFiles = null;
      maintenanceReachedListing.resolve();
      await continueMaintenance.promise;
    };

    expect(lifecycle.request(ID, 2)).toBe("scheduled");
    await oldStarted.promise;
    expect(lifecycle.request(ID, 3)).toBe("scheduled");
    const maintenance = lifecycle.maintain(ID, 3);
    await maintenanceReachedListing.promise;

    failOld.resolve();
    await waitFor(
      () =>
        settlements.some(
          (settlement) =>
            settlement.contentRevision === 2 && settlement.status === "failed",
        ),
      "old failed settlement",
    );
    continueMaintenance.resolve();
    await maintenance;
    await pendingSquareWritten.promise;

    expect(files.files.has(pendingSquareUri)).toBe(true);
    expect(files.removals).not.toContain(pendingSquareUri);
    expect(files.files.has(committed.squareUri)).toBe(true);
    expect(files.files.has(committed.originalUri)).toBe(true);

    finishPending.resolve();
    await waitFor(
      () =>
        settlements.some(
          (settlement) =>
            settlement.contentRevision === 3 && settlement.status === "committed",
        ),
      "pending pair settlement",
    );
    await expect(lifecycle.inspect(ID, 3)).resolves.toMatchObject({
      contentRevision: 3,
    });
  });

  it("reports whether a revision is scheduled, in progress, or already attempted", async () => {
    const running = setup();
    const started = deferred();
    const finish = deferred();
    running.setGenerate(async (input) => {
      started.resolve();
      await finish.promise;
      running.files.files.set(input.squareUri, Uint8Array.from([7]));
      running.files.files.set(input.originalUri, Uint8Array.from([8]));
      running.sizes.set(input.squareUri, SQUARE_SIZE);
      running.sizes.set(input.originalUri, ORIGINAL_SIZE);
      return { square: SQUARE_SIZE, original: ORIGINAL_SIZE };
    });

    expect(running.lifecycle.request(ID, 1)).toBe("scheduled");
    await started.promise;
    expect(running.lifecycle.request(ID, 1)).toBe("in-progress");
    finish.resolve();
    await waitFor(() => running.settlements.length === 1, "completed attempt");
    expect(running.lifecycle.request(ID, 1)).toBe("already-attempted");

    const invalidIdentity = setup();
    invalidIdentity.setCreateGenerationId(() => "../unsafe");

    expect(invalidIdentity.lifecycle.request(ID, 2)).toBe("already-attempted");
    expect(invalidIdentity.settlements).toEqual([
      { draftId: ID, contentRevision: 2, status: "failed" },
    ]);
    expect(invalidIdentity.lifecycle.request(ID, 2)).toBe("already-attempted");
  });

  it("detaches a supplied source before pending work can observe caller mutation", async () => {
    const { files, lifecycle, settlements, setGenerate, sizes } = setup();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let renderedBackground = "";
    setGenerate(async (input) => {
      if (input.contentRevision === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      } else {
        renderedBackground = input.document.canvas.backgroundColor;
      }
      files.files.set(input.squareUri, Uint8Array.from([7]));
      files.files.set(input.originalUri, Uint8Array.from([8]));
      sizes.set(input.squareUri, SQUARE_SIZE);
      sizes.set(input.originalUri, ORIGINAL_SIZE);
      return { square: SQUARE_SIZE, original: ORIGINAL_SIZE };
    });
    const supplied = {
      document: createDocument(),
      assets: SOURCE.assets,
    };

    expect(lifecycle.request(ID, 1)).toBe("scheduled");
    await firstStarted.promise;
    expect(lifecycle.request(ID, 2, supplied)).toBe("scheduled");
    (supplied.document.canvas as { backgroundColor: string }).backgroundColor = "#000000";
    releaseFirst.resolve();
    await waitFor(() => settlements.length === 2, "detached source settlement");

    expect(renderedBackground).toBe("#FFFFFF");
  });

  it("cleans up a definitely stale generation but preserves an unknown commit outcome", async () => {
    const stale = setup();
    stale.setCommitMode("stale");
    let staleSquareUri = "";
    let staleOriginalUri = "";
    stale.setGenerate(async (input) => {
      staleSquareUri = input.squareUri;
      staleOriginalUri = input.originalUri;
      stale.files.files.set(input.squareUri, Uint8Array.from([7]));
      stale.files.files.set(input.originalUri, Uint8Array.from([8]));
      stale.sizes.set(input.squareUri, SQUARE_SIZE);
      stale.sizes.set(input.originalUri, ORIGINAL_SIZE);
      return { square: SQUARE_SIZE, original: ORIGINAL_SIZE };
    });

    expect(stale.lifecycle.request(ID, 1)).toBe("scheduled");
    await waitFor(() => stale.settlements.length === 1, "stale attempt settlement");

    expect(stale.getCommitCallbackCalls()).toBe(0);
    expect(stale.files.files.has(staleSquareUri)).toBe(false);
    expect(stale.files.files.has(staleOriginalUri)).toBe(false);
    expect(stale.files.removals).toEqual(
      expect.arrayContaining([staleSquareUri, staleOriginalUri]),
    );

    const unknown = setup();
    unknown.setCommitMode("throw-after-commit");
    let unknownSquareUri = "";
    let unknownOriginalUri = "";
    unknown.setGenerate(async (input) => {
      unknownSquareUri = input.squareUri;
      unknownOriginalUri = input.originalUri;
      unknown.files.files.set(input.squareUri, Uint8Array.from([7]));
      unknown.files.files.set(input.originalUri, Uint8Array.from([8]));
      unknown.sizes.set(input.squareUri, SQUARE_SIZE);
      unknown.sizes.set(input.originalUri, ORIGINAL_SIZE);
      return { square: SQUARE_SIZE, original: ORIGINAL_SIZE };
    });

    expect(unknown.lifecycle.request(ID, 2)).toBe("scheduled");
    await waitFor(() => unknown.settlements.length === 1, "unknown attempt settlement");

    expect(unknown.getCommitCallbackCalls()).toBe(1);
    expect(unknown.files.files.has(unknownSquareUri)).toBe(true);
    expect(unknown.files.files.has(unknownOriginalUri)).toBe(true);
    expect(unknown.files.removals).not.toContain(unknownSquareUri);
    expect(unknown.files.removals).not.toContain(unknownOriginalUri);
    await expect(unknown.lifecycle.inspect(ID, 2)).resolves.toMatchObject({
      contentRevision: 2,
      squareUri: unknownSquareUri,
      originalUri: unknownOriginalUri,
    });
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

    expect(lifecycle.request(ID, 2)).toBe("scheduled");
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
