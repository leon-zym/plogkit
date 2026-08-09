import { importedAssetId, parseDocumentJson, type PlogDocument } from "@/core/document";

import {
  createDraftLibrary,
  draftId,
  type DraftLibraryFileAdapter,
  type DraftLibrary,
  type DraftId,
  type DraftLibraryPreviewAdapter,
  type DraftThumbnailAdapter,
  type ImportCandidate,
} from "../draftLibrary";

class MemoryDraftFiles implements DraftLibraryFileAdapter {
  readonly files = new Map<string, string | Uint8Array>();
  readonly directories = new Set<string>();
  failMoveTo: string | null = null;
  failMoveAfterDestinationRemovalTo: string | null = null;
  interruptMoveAfterDestinationRemovalTo: string | null = null;
  failMoveAfterCopyTo: string | null = null;
  interruptMoveAfterCopyTo: string | null = null;
  storageInterrupted = false;
  failMoveDirectoryAfterPartialTo: string | null = null;
  failEnsureDirectory: string | null = null;
  failFileExists: string | null = null;
  failFileExistsAfter:
    | { readonly uri: string; remainingSuccessfulCalls: number }
    | null = null;
  failReadText: string | null = null;
  failReadTextAfter: { readonly uri: string; remainingSuccessfulCalls: number } | null = null;
  failWriteText: string | null = null;
  failWriteAfterCommit: string | null = null;
  failListDirectories: string | null = null;

  async fileExists(uri: string): Promise<boolean> {
    if (this.storageInterrupted) throw new Error("storage interrupted");
    if (this.failFileExists === uri) throw new Error("wrong filesystem node");
    if (this.failFileExistsAfter?.uri === uri) {
      if (this.failFileExistsAfter.remainingSuccessfulCalls === 0) {
        this.failFileExistsAfter = null;
        throw new Error("file existence temporarily unavailable");
      }
      this.failFileExistsAfter.remainingSuccessfulCalls -= 1;
    }
    return this.files.has(uri);
  }

  async directoryExists(uri: string): Promise<boolean> {
    return this.directories.has(uri);
  }

  async ensureDirectory(uri: string): Promise<void> {
    if (this.failEnsureDirectory === uri) throw new Error("directory unavailable");
    this.directories.add(uri);
  }

  async readText(uri: string): Promise<string> {
    if (this.failReadText === uri) throw new Error("text read temporarily unavailable");
    if (this.failReadTextAfter?.uri === uri) {
      if (this.failReadTextAfter.remainingSuccessfulCalls === 0) {
        this.failReadTextAfter = null;
        throw new Error("text read temporarily unavailable");
      }
      this.failReadTextAfter.remainingSuccessfulCalls -= 1;
    }
    const value = this.files.get(uri);
    if (typeof value !== "string") throw new Error(`missing text ${uri}`);
    return value;
  }

  async writeText(uri: string, content: string): Promise<void> {
    if (this.failWriteText === uri) throw new Error("text write unavailable");
    this.files.set(uri, content);
    if (this.failWriteAfterCommit === uri) throw new Error("write result unavailable");
  }

  async copy(sourceUri: string, destinationUri: string): Promise<void> {
    const source = this.files.get(sourceUri);
    if (source === undefined) throw new Error(`missing source ${sourceUri}`);
    this.files.set(destinationUri, source);
  }

  async moveFile(sourceUri: string, destinationUri: string): Promise<void> {
    if (this.storageInterrupted) throw new Error("storage interrupted");
    if (this.failMoveTo === destinationUri) throw new Error("publication failed");
    const value = this.files.get(sourceUri);
    if (value === undefined) throw new Error(`missing ${sourceUri}`);
    if (this.failMoveAfterDestinationRemovalTo === destinationUri) {
      this.files.delete(destinationUri);
      throw new Error("move failed after destination removal");
    }
    if (this.interruptMoveAfterDestinationRemovalTo === destinationUri) {
      this.interruptMoveAfterDestinationRemovalTo = null;
      this.files.delete(destinationUri);
      this.storageInterrupted = true;
      throw new Error("process interrupted after move removed its destination");
    }
    if (this.files.has(destinationUri)) throw new Error("destination already exists");
    if (this.interruptMoveAfterCopyTo === destinationUri) {
      this.interruptMoveAfterCopyTo = null;
      this.files.set(destinationUri, value);
      this.storageInterrupted = true;
      throw new Error("process interrupted after move copied its destination");
    }
    if (this.failMoveAfterCopyTo === destinationUri) {
      this.files.set(destinationUri, value);
      throw new Error("move copied destination but could not delete source");
    }
    this.files.delete(sourceUri);
    this.files.set(destinationUri, value);
  }

  async moveDirectory(sourceUri: string, destinationUri: string): Promise<void> {
    if (this.failMoveTo === destinationUri) throw new Error("publication failed");
    if (!this.directories.has(sourceUri)) throw new Error(`missing ${sourceUri}`);
    if (this.failMoveDirectoryAfterPartialTo === destinationUri) {
      this.directories.add(destinationUri);
      const partial = [...this.files.entries()].find(([uri]) => uri.startsWith(`${sourceUri}/`));
      if (partial !== undefined) {
        const [uri, value] = partial;
        this.files.set(`${destinationUri}${uri.slice(sourceUri.length)}`, value);
      }
      throw new Error("directory move failed after partial copy");
    }
    this.directories.delete(sourceUri);
    this.directories.add(destinationUri);
    for (const directory of [...this.directories]) {
      if (directory.startsWith(`${sourceUri}/`)) {
        this.directories.delete(directory);
        this.directories.add(`${destinationUri}${directory.slice(sourceUri.length)}`);
      }
    }
    for (const [uri, value] of [...this.files]) {
      if (uri.startsWith(`${sourceUri}/`)) {
        this.files.delete(uri);
        this.files.set(`${destinationUri}${uri.slice(sourceUri.length)}`, value);
      }
    }
  }

  async removeFile(uri: string): Promise<void> {
    this.files.delete(uri);
  }

  async removeDirectory(uri: string): Promise<void> {
    if (this.storageInterrupted) throw new Error("storage interrupted");
    this.directories.delete(uri);
    for (const path of [...this.files.keys()]) {
      if (path.startsWith(`${uri}/`)) this.files.delete(path);
    }
    for (const path of [...this.directories]) {
      if (path.startsWith(`${uri}/`)) this.directories.delete(path);
    }
  }

  async listDirectories(uri: string): Promise<readonly string[]> {
    if (this.failListDirectories === uri) throw new Error("directory enumeration unavailable");
    const prefix = `${uri.replace(/\/$/, "")}/`;
    const children = new Set<string>();
    for (const path of this.directories) {
      if (!path.startsWith(prefix)) continue;
      const child = path.slice(prefix.length).split("/", 1)[0];
      if (child !== undefined && child.length > 0) children.add(`${prefix}${child}`);
    }
    return [...children];
  }

  async listFiles(uri: string): Promise<readonly string[]> {
    const prefix = `${uri.replace(/\/$/, "")}/`;
    return [...this.files.keys()].filter((path) => {
      if (!path.startsWith(prefix)) return false;
      const relative = path.slice(prefix.length);
      return relative.length > 0 && !relative.includes("/");
    });
  }
}

const candidate = (name: string): ImportCandidate => ({
  uri: `picker://${name}.jpg`,
  width: 4000,
  height: 3000,
  fileName: `${name}.jpg`,
  kind: "image",
  exif: null,
});

const firstDraftUri = "memory://library/drafts/draft-AGQAcgBhAGYAdAA6ADE";

const createDraft = (library: DraftLibrary, candidates: readonly ImportCandidate[]) =>
  library.create(candidates, { metadataPolicy: "strip" });

async function settleBackgroundWork(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function storedPairRevision(files: MemoryDraftFiles, uri: string): number | null {
  const value = files.files.get(uri);
  if (typeof value !== "string") return null;
  return (JSON.parse(value) as { readonly contentRevision: number }).contentRevision;
}

function setup() {
  const files = new MemoryDraftFiles();
  for (const name of ["one", "two", "bad", "later"]) {
    files.files.set(
      `picker://${name}.jpg`,
      new Uint8Array(name === "bad" ? [9] : [1, 2, 3]),
    );
  }
  const previews: DraftLibraryPreviewAdapter = {
    generate: async (sourceUri, destinationUri) => {
      const source = files.files.get(sourceUri);
      if (source instanceof Uint8Array && source[0] === 9) {
        throw new Error("preview decode failed");
      }
      files.files.set(destinationUri, new Uint8Array([4, 5, 6]));
      return { width: 2048, height: 1536 };
    },
    isValid: async (uri) => {
      const value = files.files.get(uri);
      return value instanceof Uint8Array && value[0] !== 0;
    },
  };
  const thumbnailSizes = new Map<string, { readonly width: number; readonly height: number }>();
  let thumbnailGenerate: DraftThumbnailAdapter["generate"] = async (input) => {
    files.files.set(input.squareUri, new Uint8Array([7, input.contentRevision]));
    files.files.set(input.originalUri, new Uint8Array([8, input.contentRevision]));
    const square = { width: 360, height: 360 } as const;
    const original = { width: 720, height: 540 } as const;
    thumbnailSizes.set(input.squareUri, square);
    thumbnailSizes.set(input.originalUri, original);
    return { square, original };
  };
  const thumbnails: DraftThumbnailAdapter = {
    generate: (input) => thumbnailGenerate(input),
    inspect: async (uri) => (files.files.has(uri) ? (thumbnailSizes.get(uri) ?? null) : null),
  };
  let assetSequence = 0;
  let storageSequence = 0;
  let operationSequence = 0;
  let thumbnailSequence = 0;
  let draftSequence = 0;
  let createDraftIdentity = () => draftId(`draft:${++draftSequence}`);
  let now = "2026-07-22T08:00:00.000Z";
  const createLibrary = () =>
    createDraftLibrary({
      files,
      previews,
      thumbnails,
      rootUri: "memory://library",
      createAssetId: () => importedAssetId(`provider:item/../${++assetSequence}`),
      createStorageKey: () => `asset-${++storageSequence}`,
      createOperationId: () => `operation-${++operationSequence}`,
      createThumbnailGenerationId: () => `thumbnail-${++thumbnailSequence}`,
      createDraftId: () => createDraftIdentity(),
      now: () => now,
    });
  return {
    files,
    previews,
    thumbnails,
    library: createLibrary(),
    createLibrary,
    getDraftSequence: () => draftSequence,
    setNow: (value: string) => {
      now = value;
    },
    setCreateDraftId: (create: () => DraftId) => {
      createDraftIdentity = create;
    },
    setThumbnailGenerate: (generate: DraftThumbnailAdapter["generate"]) => {
      thumbnailGenerate = generate;
    },
    thumbnailSizes,
  };
}

describe("Draft Library", () => {
  it("installs one reliable snapshot through a single-flight initial load", async () => {
    const { files, library } = setup();
    let releaseEnumeration!: () => void;
    const enumerationGate = new Promise<void>((resolve) => {
      releaseEnumeration = resolve;
    });
    const originalListDirectories = files.listDirectories.bind(files);
    files.listDirectories = async (uri) => {
      if (uri === "memory://library/drafts") {
        await enumerationGate;
      }
      return originalListDirectories(uri);
    };

    const first = library.load();
    const second = library.load();

    expect(first).toBe(second);
    expect(library.getState()).toEqual({ status: "loading" });
    releaseEnumeration();
    await expect(first).resolves.toEqual({ status: "ready", entries: [] });
    expect(library.getState()).toEqual({ status: "ready", entries: [] });
  });

  it("waits for the initial load before publishing a concurrently created Draft", async () => {
    const { files, library, createLibrary, setNow } = setup();
    const existing = await createDraft(library, [candidate("one")]);
    if (existing.status !== "created") throw new Error("expected an existing Draft");
    setNow("2026-07-22T09:00:00.000Z");
    const restarted = createLibrary();
    let releaseEnumeration!: () => void;
    const enumerationGate = new Promise<void>((resolve) => {
      releaseEnumeration = resolve;
    });
    const originalListDirectories = files.listDirectories.bind(files);
    files.listDirectories = async (uri) => {
      if (uri === "memory://library/drafts") await enumerationGate;
      return originalListDirectories(uri);
    };

    const creating = createDraft(restarted, [candidate("two")]);
    await Promise.resolve();
    expect(
      [...files.files.keys()].filter((uri) => uri.endsWith("/publication.json")),
    ).toHaveLength(1);
    releaseEnumeration();

    await expect(creating).resolves.toMatchObject({ status: "created", draftId: "draft:2" });
    expect(restarted.getState()).toMatchObject({
      status: "ready",
      entries: [{ draftId: "draft:2" }, { draftId: "draft:1" }],
    });
  });

  it("does not write a saved root before a cold-start load finishes enumeration", async () => {
    const { files, library, createLibrary, setNow } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    await settleBackgroundWork();
    const restarted = createLibrary();
    let markEnumerationStarted!: () => void;
    const enumerationStarted = new Promise<void>((resolve) => {
      markEnumerationStarted = resolve;
    });
    let releaseEnumeration!: () => void;
    const enumerationGate = new Promise<void>((resolve) => {
      releaseEnumeration = resolve;
    });
    const originalListDirectories = files.listDirectories.bind(files);
    files.listDirectories = async (uri) => {
      if (uri === "memory://library/drafts") {
        markEnumerationStarted();
        await enumerationGate;
      }
      return originalListDirectories(uri);
    };
    const rootUri = `${firstDraftUri}/draft.json`;
    const next = updateDocument(created.document, {
      canvas: { ...created.document.canvas, backgroundColor: "#112233" },
    });
    setNow("2026-07-22T09:00:00.000Z");

    const saving = restarted.save(created.draftId, next);
    await enumerationStarted;

    expect(JSON.parse(await files.readText(rootUri))).toMatchObject({
      contentRevision: 1,
      document: created.document,
    });
    expect(files.files.has(`${rootUri}.tmp`)).toBe(false);

    releaseEnumeration();
    await expect(saving).resolves.toMatchObject({
      status: "saved",
      contentRevision: 2,
      document: next,
    });
  });

  it("does not write a deletion marker before a cold-start load finishes enumeration", async () => {
    const { files, library, createLibrary } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    await settleBackgroundWork();
    const restarted = createLibrary();
    let markEnumerationStarted!: () => void;
    const enumerationStarted = new Promise<void>((resolve) => {
      markEnumerationStarted = resolve;
    });
    let releaseEnumeration!: () => void;
    const enumerationGate = new Promise<void>((resolve) => {
      releaseEnumeration = resolve;
    });
    const originalListDirectories = files.listDirectories.bind(files);
    files.listDirectories = async (uri) => {
      if (uri === "memory://library/drafts") {
        markEnumerationStarted();
        await enumerationGate;
      }
      return originalListDirectories(uri);
    };
    const markerUri = `${firstDraftUri.replace("/drafts/", "/deletions/")}.json`;

    const deleting = restarted.deleteDraft(created.draftId);
    await enumerationStarted;

    expect(files.files.has(markerUri)).toBe(false);
    expect(files.directories.has(firstDraftUri)).toBe(true);

    releaseEnumeration();
    await expect(deleting).resolves.toEqual({ status: "deleted" });
  });

  it("publishes a root record before the immutable creation commit point", async () => {
    const { files, library, createLibrary } = setup();

    const created = await createDraft(library, [candidate("one")]);

    expect(created).toMatchObject({
      status: "created",
      contentRevision: 1,
      metadata: {
        createdAt: "2026-07-22T08:00:00.000Z",
        updatedAt: "2026-07-22T08:00:00.000Z",
      },
    });
    expect(JSON.parse(await files.readText(`${firstDraftUri}/publication.json`))).toEqual({
      publicationSchemaVersion: 1,
      draftId: "draft:1",
    });
    expect(JSON.parse(await files.readText(`${firstDraftUri}/draft.json`))).toMatchObject({
      draftSchemaVersion: 1,
      draftId: "draft:1",
      contentRevision: 1,
      metadata: {
        createdAt: "2026-07-22T08:00:00.000Z",
        updatedAt: "2026-07-22T08:00:00.000Z",
      },
    });
    expect(library.getState()).toMatchObject({
      status: "ready",
      entries: [
        {
          status: "ready",
          draftId: "draft:1",
          contentRevision: 1,
          updatedAt: "2026-07-22T08:00:00.000Z",
          photoCount: 1,
        },
      ],
    });

    await expect(createLibrary().load()).resolves.toMatchObject({
      status: "ready",
      entries: [{ status: "ready", draftId: "draft:1", contentRevision: 1 }],
    });
  });

  it("sorts all Drafts by updated time and uses stable identity order for ties", async () => {
    const { library, createLibrary, setCreateDraftId, setNow } = setup();
    const identities = [draftId("draft:older"), draftId("draft:tie-b"), draftId("draft:tie-a")];
    setCreateDraftId(() => {
      const identity = identities.shift();
      if (identity === undefined) throw new Error("missing fixture identity");
      return identity;
    });

    setNow("2026-07-22T08:00:00.000Z");
    await createDraft(library, [candidate("one")]);
    setNow("2026-07-22T10:00:00.000Z");
    await createDraft(library, [candidate("two")]);
    await createDraft(library, [candidate("later")]);

    expect(library.getState()).toMatchObject({
      status: "ready",
      entries: [
        { draftId: "draft:tie-a", updatedAt: "2026-07-22T10:00:00.000Z" },
        { draftId: "draft:tie-b", updatedAt: "2026-07-22T10:00:00.000Z" },
        { draftId: "draft:older", updatedAt: "2026-07-22T08:00:00.000Z" },
      ],
    });
    await expect(createLibrary().load()).resolves.toMatchObject({
      status: "ready",
      entries: [{ draftId: "draft:tie-a" }, { draftId: "draft:tie-b" }, { draftId: "draft:older" }],
    });
  });

  it("places missing updated times first and keeps those corrupt entries stable", async () => {
    const { files, library, createLibrary, setCreateDraftId, setNow } = setup();
    const identities = [
      draftId("draft:missing-z"),
      draftId("draft:dated"),
      draftId("draft:missing-a"),
    ];
    setCreateDraftId(() => {
      const identity = identities.shift();
      if (identity === undefined) throw new Error("missing fixture identity");
      return identity;
    });
    setNow("2026-07-22T08:00:00.000Z");
    const missingZ = await createDraft(library, [candidate("one")]);
    setNow("2026-07-22T09:00:00.000Z");
    const dated = await createDraft(library, [candidate("two")]);
    setNow("2026-07-22T10:00:00.000Z");
    const missingA = await createDraft(library, [candidate("later")]);
    if (
      missingZ.status !== "created" ||
      dated.status !== "created" ||
      missingA.status !== "created"
    ) {
      throw new Error("expected three created Drafts");
    }
    for (const created of [missingZ, missingA]) {
      const original = created.assets.resolve(created.document.sourceImages[0]!.id, "original");
      if (original === null) throw new Error("expected an original descriptor");
      await files.writeText(`${original.uri.split("/assets/", 1)[0]}/draft.json`, "not-json");
    }

    const restarted = createLibrary();
    await expect(restarted.load()).resolves.toMatchObject({
      status: "ready",
      entries: [
        { status: "corrupt", draftId: "draft:missing-a", updatedAt: null },
        { status: "corrupt", draftId: "draft:missing-z", updatedAt: null },
        {
          status: "ready",
          draftId: dated.draftId,
          updatedAt: "2026-07-22T09:00:00.000Z",
        },
      ],
    });
    await expect(createLibrary().load()).resolves.toMatchObject({
      status: "ready",
      entries: [
        { draftId: "draft:missing-a" },
        { draftId: "draft:missing-z" },
        { draftId: "draft:dated" },
      ],
    });
  });

  it("moves only successfully changed content and preserves time after no-op or failed saves", async () => {
    const { files, library, createLibrary, setNow } = setup();
    setNow("2026-07-22T08:00:00.000Z");
    const first = await createDraft(library, [candidate("one")]);
    setNow("2026-07-22T09:00:00.000Z");
    const second = await createDraft(library, [candidate("two")]);
    if (first.status !== "created" || second.status !== "created") {
      throw new Error("expected two created Drafts");
    }
    const changed = updateDocument(first.document, {
      canvas: { ...first.document.canvas, backgroundColor: "#135724" },
    });

    setNow("2026-07-22T10:00:00.000Z");
    await expect(library.save(first.draftId, changed)).resolves.toMatchObject({
      status: "saved",
      contentRevision: 2,
      metadata: { updatedAt: "2026-07-22T10:00:00.000Z" },
    });
    expect(library.getState()).toMatchObject({
      entries: [
        { draftId: first.draftId, updatedAt: "2026-07-22T10:00:00.000Z" },
        { draftId: second.draftId, updatedAt: "2026-07-22T09:00:00.000Z" },
      ],
    });

    setNow("2026-07-22T11:00:00.000Z");
    await expect(library.save(first.draftId, changed)).resolves.toMatchObject({
      status: "saved",
      contentRevision: 2,
      metadata: { updatedAt: "2026-07-22T10:00:00.000Z" },
    });

    const secondOriginal = second.assets.resolve(second.document.sourceImages[0]!.id, "original");
    if (secondOriginal === null) throw new Error("expected the second original");
    const secondRoot = `${secondOriginal.uri.split("/assets/", 1)[0]}/draft.json`;
    files.failMoveTo = secondRoot;
    setNow("2026-07-22T12:00:00.000Z");
    await expect(
      library.save(
        second.draftId,
        updateDocument(second.document, {
          canvas: { ...second.document.canvas, backgroundColor: "#246813" },
        }),
      ),
    ).resolves.toMatchObject({ status: "save-failed" });
    files.failMoveTo = null;

    await expect(createLibrary().load()).resolves.toMatchObject({
      status: "ready",
      entries: [
        { draftId: first.draftId, updatedAt: "2026-07-22T10:00:00.000Z" },
        { draftId: second.draftId, updatedAt: "2026-07-22T09:00:00.000Z" },
      ],
    });
  });

  it("keeps ordering metadata unchanged through browse, preview repair, thumbnail rebuild, and maintenance", async () => {
    const { files, library, setNow } = setup();
    setNow("2026-07-22T08:00:00.000Z");
    const older = await createDraft(library, [candidate("one")]);
    setNow("2026-07-22T09:00:00.000Z");
    const newer = await createDraft(library, [candidate("two")]);
    if (older.status !== "created" || newer.status !== "created") {
      throw new Error("expected two created Drafts");
    }
    await settleBackgroundWork();
    const expected = [
      { draftId: newer.draftId, updatedAt: "2026-07-22T09:00:00.000Z" },
      { draftId: older.draftId, updatedAt: "2026-07-22T08:00:00.000Z" },
    ];
    const expectStableProjection = () => {
      expect(library.getState()).toMatchObject({ status: "ready", entries: expected });
    };
    expectStableProjection();

    await expect(library.read(older.draftId)).resolves.toMatchObject({ status: "ready" });
    expectStableProjection();

    const imageId = older.document.sourceImages[0]!.id;
    const preview = older.assets.resolve(imageId, "preview");
    if (preview === null) throw new Error("expected a preview descriptor");
    await files.removeFile(preview.uri);
    await expect(library.readPreview(older.draftId, imageId)).resolves.toMatchObject({
      status: "ready",
    });
    expectStableProjection();

    const stateBeforeThumbnailRepair = library.getState();
    const olderEntry =
      stateBeforeThumbnailRepair.status === "ready"
        ? stateBeforeThumbnailRepair.entries.find(({ draftId: id }) => id === older.draftId)
        : undefined;
    if (olderEntry?.thumbnail === null || olderEntry?.thumbnail === undefined) {
      throw new Error("expected a generated thumbnail pair");
    }
    library.reportThumbnailLoadFailure(older.draftId, olderEntry.thumbnail);
    await settleBackgroundWork();
    expectStableProjection();

    await library.maintainInactive(older.draftId);
    expectStableProjection();
  });

  it("serializes colliding creation publication without removing the winning Draft", async () => {
    const { files, library, createLibrary, setCreateDraftId } = setup();
    setCreateDraftId(() => draftId("draft:1"));
    let releaseStaging!: () => void;
    const stagingGate = new Promise<void>((resolve) => {
      releaseStaging = resolve;
    });
    let markBothStaged!: () => void;
    const bothStaged = new Promise<void>((resolve) => {
      markBothStaged = resolve;
    });
    const stagedRoots = new Set<string>();
    const originalWrite = files.writeText.bind(files);
    files.writeText = async (uri, content) => {
      await originalWrite(uri, content);
      if (uri.includes("/staging/") && uri.endsWith("/aggregate/draft.json")) {
        stagedRoots.add(uri);
        if (stagedRoots.size === 2) markBothStaged();
        await stagingGate;
      }
    };

    const first = createDraft(library, [candidate("one")]);
    const second = createDraft(library, [candidate("two")]);
    await bothStaged;
    releaseStaging();
    const results = await Promise.all([first, second]);

    expect(results.map(({ status }) => status).sort()).toEqual(["create-failed", "created"]);
    expect(files.directories.has(firstDraftUri)).toBe(true);
    await expect(createLibrary().load()).resolves.toMatchObject({
      status: "ready",
      entries: [{ status: "ready", draftId: "draft:1" }],
    });
  });

  it("determines creation only from the canonical publication record", async () => {
    const failed = setup();
    failed.files.failWriteText = `${firstDraftUri}/publication.json`;

    await expect(createDraft(failed.library, [candidate("one")])).resolves.toMatchObject({
      status: "create-failed",
      message: "text write unavailable",
    });
    failed.files.failWriteText = null;
    await expect(failed.createLibrary().load()).resolves.toEqual({
      status: "ready",
      entries: [],
    });

    const committed = setup();
    committed.files.failWriteAfterCommit = `${firstDraftUri}/publication.json`;
    await expect(createDraft(committed.library, [candidate("one")])).resolves.toMatchObject({
      status: "created",
      draftId: "draft:1",
    });
    committed.files.failWriteAfterCommit = null;
    await expect(committed.createLibrary().load()).resolves.toMatchObject({
      status: "ready",
      entries: [{ status: "ready", draftId: "draft:1" }],
    });
  });

  it("preserves a published aggregate when the canonical publication result is unknown", async () => {
    const { files, library, createLibrary } = setup();
    const publicationUri = `${firstDraftUri}/publication.json`;
    files.failReadText = publicationUri;

    await expect(createDraft(library, [candidate("one")])).resolves.toMatchObject({
      status: "create-failed",
      message: "text read temporarily unavailable",
    });
    expect(library.getState()).toMatchObject({ status: "storage-failed" });
    expect(files.directories.has(firstDraftUri)).toBe(true);
    expect(files.files.has(publicationUri)).toBe(true);

    files.failReadText = null;
    await expect(createLibrary().load()).resolves.toMatchObject({
      status: "ready",
      entries: [{ status: "ready", draftId: "draft:1" }],
    });
  });

  it("commits document, content revision, and updated time as one semantic version", async () => {
    const { files, library, createLibrary, setNow } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    const changed = updateDocument(created.document, {
      canvas: { ...created.document.canvas, backgroundColor: "#123456" },
    });
    setNow("2026-07-22T09:00:00.000Z");
    files.failMoveAfterCopyTo = `${firstDraftUri}/draft.json`;

    await expect(library.save(created.draftId, changed)).resolves.toMatchObject({
      status: "saved",
      contentRevision: 2,
      metadata: { updatedAt: "2026-07-22T09:00:00.000Z" },
    });
    files.failMoveAfterCopyTo = null;
    setNow("2026-07-22T10:00:00.000Z");
    await expect(library.save(created.draftId, changed)).resolves.toMatchObject({
      status: "saved",
      contentRevision: 2,
      metadata: { updatedAt: "2026-07-22T09:00:00.000Z" },
    });

    const rejected = updateDocument(changed, {
      canvas: { ...changed.canvas, backgroundColor: "#654321" },
    });
    files.failMoveTo = `${firstDraftUri}/draft.json`;
    await expect(library.save(created.draftId, rejected)).resolves.toMatchObject({
      status: "save-failed",
      reason: "storage-failed",
    });
    files.failMoveTo = null;

    await expect(createLibrary().read(created.draftId)).resolves.toMatchObject({
      status: "ready",
      document: changed,
      contentRevision: 2,
      metadata: { updatedAt: "2026-07-22T09:00:00.000Z" },
    });
  });

  it("does not let a failing state observer change a committed save result", async () => {
    const { library, setNow } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    const unsubscribe = library.subscribe(() => {
      throw new Error("observer failed");
    });
    setNow("2026-07-22T09:00:00.000Z");

    await expect(
      library.save(
        created.draftId,
        updateDocument(created.document, {
          canvas: { ...created.document.canvas, backgroundColor: "#445566" },
        }),
      ),
    ).resolves.toMatchObject({ status: "saved", contentRevision: 2 });
    expect(library.getState()).toMatchObject({
      status: "ready",
      entries: [{ status: "ready", contentRevision: 2 }],
    });
    unsubscribe();
  });

  it("switches square and original thumbnails only as one revision-matched pair", async () => {
    const { files, library, setNow, setThumbnailGenerate, thumbnailSizes } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    await settleBackgroundWork();
    expect(library.getState()).toMatchObject({
      status: "ready",
      entries: [
        {
          thumbnailStatus: "ready",
          thumbnail: { contentRevision: 1, profileVersion: 1 },
        },
      ],
    });

    let markSquareWritten!: () => void;
    const squareWritten = new Promise<void>((resolve) => {
      markSquareWritten = resolve;
    });
    let releaseOriginal!: () => void;
    const originalGate = new Promise<void>((resolve) => {
      releaseOriginal = resolve;
    });
    setThumbnailGenerate(async (input) => {
      const square = { width: 360, height: 360 } as const;
      const original = { width: 720, height: 540 } as const;
      files.files.set(input.squareUri, new Uint8Array([7, input.contentRevision]));
      thumbnailSizes.set(input.squareUri, square);
      markSquareWritten();
      await originalGate;
      files.files.set(input.originalUri, new Uint8Array([8, input.contentRevision]));
      thumbnailSizes.set(input.originalUri, original);
      return { square, original };
    });
    setNow("2026-07-22T09:00:00.000Z");
    const revisionTwo = updateDocument(created.document, {
      canvas: { ...created.document.canvas, backgroundColor: "#111111" },
    });
    await library.save(created.draftId, revisionTwo);
    await squareWritten;
    expect(library.getState()).toMatchObject({
      entries: [{ thumbnail: { contentRevision: 1 }, thumbnailStatus: "generating" }],
    });

    setNow("2026-07-22T10:00:00.000Z");
    const revisionThree = updateDocument(revisionTwo, {
      canvas: { ...revisionTwo.canvas, backgroundColor: "#222222" },
    });
    await library.save(created.draftId, revisionThree);
    releaseOriginal();
    await settleBackgroundWork();

    expect(library.getState()).toMatchObject({
      status: "ready",
      entries: [
        {
          contentRevision: 3,
          thumbnailStatus: "ready",
          thumbnail: { contentRevision: 3, profileVersion: 1 },
        },
      ],
    });
  });

  it("installs the recovered pair into the authoritative snapshot after restart", async () => {
    const { files, library, createLibrary, setNow } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    await settleBackgroundWork();
    const initial = library.getState();
    if (
      initial.status !== "ready" ||
      initial.entries[0]?.status !== "ready" ||
      initial.entries[0].thumbnail === null
    ) {
      throw new Error("expected the initial thumbnail pair");
    }
    const initialPair = initial.entries[0].thumbnail;
    let markInterruptedAttemptSettled!: () => void;
    const interruptedAttemptSettled = new Promise<void>((resolve) => {
      markInterruptedAttemptSettled = resolve;
    });
    const unsubscribe = library.subscribe(() => {
      const state = library.getState();
      const entry = state.status === "ready" ? state.entries[0] : undefined;
      if (
        entry?.status === "ready" &&
        entry.contentRevision === 2 &&
        entry.thumbnail?.contentRevision === 1 &&
        entry.thumbnailStatus === "ready"
      ) {
        markInterruptedAttemptSettled();
      }
    });
    const pairUri = `${firstDraftUri}/thumbnail-pair.json`;
    files.interruptMoveAfterCopyTo = pairUri;
    setNow("2026-07-22T09:00:00.000Z");

    await expect(
      library.save(
        created.draftId,
        updateDocument(created.document, {
          canvas: { ...created.document.canvas, backgroundColor: "#101010" },
        }),
      ),
    ).resolves.toMatchObject({ status: "saved", contentRevision: 2 });
    await interruptedAttemptSettled;
    unsubscribe();

    expect(files.storageInterrupted).toBe(true);
    expect(library.getState()).toMatchObject({
      entries: [
        {
          contentRevision: 2,
          thumbnail: initialPair,
          thumbnailStatus: "ready",
        },
      ],
    });
    files.storageInterrupted = false;
    expect({
      current: storedPairRevision(files, pairUri),
      backup: storedPairRevision(files, `${pairUri}.backup`),
      temporary: storedPairRevision(files, `${pairUri}.tmp`),
    }).toEqual({ current: 2, backup: 1, temporary: 2 });

    const restarted = createLibrary();
    const loaded = await restarted.load();

    expect(loaded).toMatchObject({
      status: "ready",
      entries: [
        {
          contentRevision: 2,
          thumbnail: { contentRevision: 2, profileVersion: 1 },
          thumbnailStatus: "ready",
        },
      ],
    });
    expect(restarted.getState()).toEqual(loaded);
    expect(storedPairRevision(files, pairUri)).toBe(2);
    expect(files.files.has(`${pairUri}.backup`)).toBe(false);
    expect(files.files.has(`${pairUri}.tmp`)).toBe(false);
  });

  it("never publishes a stale supplied-source pair while the newest render is pending", async () => {
    const { files, library, setNow, setThumbnailGenerate, thumbnailSizes } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    await settleBackgroundWork();

    const observed: {
      readonly contentRevision: number;
      readonly pairRevision: number | null;
      readonly thumbnailStatus: string;
    }[] = [];
    let markRevisionThreeCommitted!: () => void;
    const revisionThreeCommitted = new Promise<void>((resolve) => {
      markRevisionThreeCommitted = resolve;
    });
    const unsubscribe = library.subscribe(() => {
      const snapshot = library.getState();
      const entry = snapshot.status === "ready" ? snapshot.entries[0] : undefined;
      if (entry?.status === "ready") {
        observed.push({
          contentRevision: entry.contentRevision,
          pairRevision: entry.thumbnail?.contentRevision ?? null,
          thumbnailStatus: entry.thumbnailStatus,
        });
        if (
          entry.contentRevision === 3 &&
          entry.thumbnail?.contentRevision === 3 &&
          entry.thumbnailStatus === "ready"
        ) {
          markRevisionThreeCommitted();
        }
      }
    });

    let markRevisionTwoStarted!: () => void;
    const revisionTwoStarted = new Promise<void>((resolve) => {
      markRevisionTwoStarted = resolve;
    });
    let releaseRevisionTwo!: () => void;
    const revisionTwoGate = new Promise<void>((resolve) => {
      releaseRevisionTwo = resolve;
    });
    let markRevisionThreeStarted!: () => void;
    const revisionThreeStarted = new Promise<void>((resolve) => {
      markRevisionThreeStarted = resolve;
    });
    let releaseRevisionThree!: () => void;
    const revisionThreeGate = new Promise<void>((resolve) => {
      releaseRevisionThree = resolve;
    });
    setThumbnailGenerate(async (input) => {
      if (input.contentRevision === 2) {
        markRevisionTwoStarted();
        await revisionTwoGate;
      } else if (input.contentRevision === 3) {
        markRevisionThreeStarted();
        await revisionThreeGate;
      }
      const square = { width: 360, height: 360 } as const;
      const original = { width: 720, height: 540 } as const;
      files.files.set(input.squareUri, new Uint8Array([7, input.contentRevision]));
      files.files.set(input.originalUri, new Uint8Array([8, input.contentRevision]));
      thumbnailSizes.set(input.squareUri, square);
      thumbnailSizes.set(input.originalUri, original);
      return { square, original };
    });
    setNow("2026-07-22T09:00:00.000Z");
    const revisionTwo = updateDocument(created.document, {
      canvas: { ...created.document.canvas, backgroundColor: "#212121" },
    });
    await expect(library.save(created.draftId, revisionTwo)).resolves.toMatchObject({
      status: "saved",
      contentRevision: 2,
    });
    await revisionTwoStarted;

    setNow("2026-07-22T10:00:00.000Z");
    const revisionThree = updateDocument(revisionTwo, {
      canvas: { ...revisionTwo.canvas, backgroundColor: "#313131" },
    });
    await expect(library.save(created.draftId, revisionThree)).resolves.toMatchObject({
      status: "saved",
      contentRevision: 3,
    });

    releaseRevisionTwo();
    await revisionThreeStarted;

    expect(library.getState()).toMatchObject({
      entries: [
        {
          contentRevision: 3,
          thumbnail: { contentRevision: 1 },
          thumbnailStatus: "generating",
        },
      ],
    });
    expect(observed.some(({ pairRevision }) => pairRevision === 2)).toBe(false);
    expect(storedPairRevision(files, `${firstDraftUri}/thumbnail-pair.json`)).toBe(1);

    releaseRevisionThree();
    await revisionThreeCommitted;
    unsubscribe();
    expect(library.getState()).toMatchObject({
      entries: [
        {
          contentRevision: 3,
          thumbnail: { contentRevision: 3 },
          thumbnailStatus: "ready",
        },
      ],
    });
  });

  it("commits an exact-revision pair when ingest adds an unreferenced catalog entry", async () => {
    const { files, library, setNow, setThumbnailGenerate, thumbnailSizes } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    await settleBackgroundWork();
    let markRenderStarted!: () => void;
    const renderStarted = new Promise<void>((resolve) => {
      markRenderStarted = resolve;
    });
    let releaseRender!: () => void;
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    setThumbnailGenerate(async (input) => {
      markRenderStarted();
      await renderGate;
      const square = { width: 360, height: 360 } as const;
      const original = { width: 720, height: 540 } as const;
      files.files.set(input.squareUri, new Uint8Array([7, input.contentRevision]));
      files.files.set(input.originalUri, new Uint8Array([8, input.contentRevision]));
      thumbnailSizes.set(input.squareUri, square);
      thumbnailSizes.set(input.originalUri, original);
      return { square, original };
    });
    setNow("2026-07-22T09:00:00.000Z");
    await expect(
      library.save(
        created.draftId,
        updateDocument(created.document, {
          canvas: { ...created.document.canvas, backgroundColor: "#323232" },
        }),
      ),
    ).resolves.toMatchObject({ status: "saved", contentRevision: 2 });
    await renderStarted;

    await expect(library.ingest(created.draftId, [candidate("two")])).resolves.toMatchObject({
      status: "ingested",
      imported: [{ image: { id: "provider:item/../2" } }],
    });
    releaseRender();
    await settleBackgroundWork();

    expect(library.getState()).toMatchObject({
      entries: [
        {
          contentRevision: 2,
          thumbnail: { contentRevision: 2 },
          thumbnailStatus: "ready",
        },
      ],
    });
  });

  it("keeps the previous complete thumbnail pair when a new generation fails", async () => {
    const { library, setNow, setThumbnailGenerate } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    await settleBackgroundWork();
    let markRenderAttempted!: () => void;
    const renderAttempted = new Promise<void>((resolve) => {
      markRenderAttempted = resolve;
    });
    setThumbnailGenerate(async () => {
      markRenderAttempted();
      throw new Error("thumbnail render failed");
    });
    let markFailureSettled!: () => void;
    const failureSettled = new Promise<void>((resolve) => {
      markFailureSettled = resolve;
    });
    const unsubscribe = library.subscribe(() => {
      const state = library.getState();
      const entry = state.status === "ready" ? state.entries[0] : undefined;
      if (
        entry?.status === "ready" &&
        entry.contentRevision === 2 &&
        entry.thumbnail?.contentRevision === 1 &&
        entry.thumbnailStatus === "ready"
      ) {
        markFailureSettled();
      }
    });
    setNow("2026-07-22T09:00:00.000Z");

    await expect(
      library.save(
        created.draftId,
        updateDocument(created.document, {
          canvas: { ...created.document.canvas, backgroundColor: "#333333" },
        }),
      ),
    ).resolves.toMatchObject({ status: "saved", contentRevision: 2 });
    await renderAttempted;
    await failureSettled;
    unsubscribe();

    expect(library.getState()).toMatchObject({
      entries: [
        {
          contentRevision: 2,
          thumbnailStatus: "ready",
          thumbnail: { contentRevision: 1 },
        },
      ],
    });
  });

  it("does not resurrect a Draft when thumbnail generation finishes after deletion", async () => {
    const { files, library, setNow, setThumbnailGenerate, thumbnailSizes, createLibrary } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    await settleBackgroundWork();

    let markRenderStarted!: () => void;
    const renderStarted = new Promise<void>((resolve) => {
      markRenderStarted = resolve;
    });
    let markRenderFinished!: () => void;
    const renderFinished = new Promise<void>((resolve) => {
      markRenderFinished = resolve;
    });
    let releaseRender!: () => void;
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    let generatedUris: readonly string[] = [];
    setThumbnailGenerate(async (input) => {
      const square = { width: 360, height: 360 } as const;
      const original = { width: 720, height: 540 } as const;
      generatedUris = [input.squareUri, input.originalUri];
      markRenderStarted();
      await renderGate;
      files.files.set(input.squareUri, new Uint8Array([7, input.contentRevision]));
      files.files.set(input.originalUri, new Uint8Array([8, input.contentRevision]));
      thumbnailSizes.set(input.squareUri, square);
      thumbnailSizes.set(input.originalUri, original);
      markRenderFinished();
      return { square, original };
    });
    setNow("2026-07-22T09:00:00.000Z");
    await library.save(
      created.draftId,
      updateDocument(created.document, {
        canvas: { ...created.document.canvas, backgroundColor: "#414141" },
      }),
    );
    await renderStarted;

    await expect(library.deleteDraft(created.draftId)).resolves.toEqual({
      status: "deleted",
    });
    expect(library.getState()).toEqual({ status: "ready", entries: [] });

    releaseRender();
    await renderFinished;
    await Promise.resolve();
    await Promise.resolve();
    await library.maintainInactive(created.draftId);

    expect(library.getState()).toEqual({ status: "ready", entries: [] });
    expect(generatedUris).toHaveLength(2);
    expect(generatedUris.every((uri) => !files.files.has(uri))).toBe(true);
    expect([...files.files.keys()].some((uri) => uri.startsWith(`${firstDraftUri}/`))).toBe(false);
    await expect(createLibrary().load()).resolves.toEqual({ status: "ready", entries: [] });
  });

  it("does not publish or retain late thumbnails while deletion outcome is unknown", async () => {
    const { files, library, setNow, setThumbnailGenerate, thumbnailSizes } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    await settleBackgroundWork();
    let markRenderStarted!: () => void;
    const renderStarted = new Promise<void>((resolve) => {
      markRenderStarted = resolve;
    });
    let releaseRender!: () => void;
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    let markRenderFinished!: () => void;
    const renderFinished = new Promise<void>((resolve) => {
      markRenderFinished = resolve;
    });
    let generatedUris: readonly string[] = [];
    setThumbnailGenerate(async (input) => {
      const square = { width: 360, height: 360 } as const;
      const original = { width: 720, height: 540 } as const;
      generatedUris = [input.squareUri, input.originalUri];
      markRenderStarted();
      await renderGate;
      files.files.set(input.squareUri, new Uint8Array([7, input.contentRevision]));
      files.files.set(input.originalUri, new Uint8Array([8, input.contentRevision]));
      thumbnailSizes.set(input.squareUri, square);
      thumbnailSizes.set(input.originalUri, original);
      markRenderFinished();
      return { square, original };
    });
    setNow("2026-07-22T09:00:00.000Z");
    await expect(
      library.save(
        created.draftId,
        updateDocument(created.document, {
          canvas: { ...created.document.canvas, backgroundColor: "#424242" },
        }),
      ),
    ).resolves.toMatchObject({ status: "saved", contentRevision: 2 });
    await renderStarted;
    const markerUri = `${firstDraftUri.replace("/drafts/", "/deletions/")}.json`;
    files.failReadText = markerUri;

    await expect(library.deleteDraft(created.draftId)).resolves.toMatchObject({
      status: "delete-unknown",
    });
    expect(library.getState()).toMatchObject({ status: "storage-failed" });
    files.failReadText = null;

    releaseRender();
    await renderFinished;
    await Promise.resolve();
    await Promise.resolve();
    await library.maintainInactive(created.draftId);

    expect(JSON.parse(await files.readText(`${firstDraftUri}/thumbnail-pair.json`))).toMatchObject({
      contentRevision: 1,
    });
    expect(generatedUris).toHaveLength(2);
    expect(generatedUris.every((uri) => !files.files.has(uri))).toBe(true);
  });

  it("degrades a visible failed pair as one unit and schedules one cold-process rebuild", async () => {
    const { library, createLibrary } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    await settleBackgroundWork();
    const restarted = createLibrary();
    const loaded = await restarted.load();
    if (loaded.status !== "ready" || loaded.entries[0]?.thumbnail === null) {
      throw new Error("expected a committed pair");
    }
    const failedPair = loaded.entries[0].thumbnail;

    restarted.reportThumbnailLoadFailure(created.draftId, {
      ...failedPair,
      squareUri: `${failedPair.squareUri}.stale`,
    });
    expect(restarted.getState()).toEqual(loaded);

    restarted.reportThumbnailLoadFailure(created.draftId, failedPair);

    expect(restarted.getState()).toMatchObject({
      entries: [{ thumbnail: null, thumbnailStatus: "generating" }],
    });
    await settleBackgroundWork();
    expect(restarted.getState()).toMatchObject({
      entries: [
        {
          thumbnailStatus: "ready",
          thumbnail: { contentRevision: 1, profileVersion: 1 },
        },
      ],
    });
    const state = restarted.getState();
    if (state.status !== "ready" || state.entries[0]?.thumbnail === null) {
      throw new Error("expected rebuilt pair");
    }
    expect(state.entries[0].thumbnail.squareUri).not.toBe(failedPair.squareUri);
  });

  it("marks a visible pair unavailable after this process already attempted its revision", async () => {
    const { files, library } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    await settleBackgroundWork();
    const loaded = library.getState();
    if (loaded.status !== "ready" || loaded.entries[0]?.thumbnail === null) {
      throw new Error("expected a committed pair");
    }
    const failedPair = loaded.entries[0].thumbnail;
    const generatedBeforeFailure = [...files.files.keys()].filter(
      (uri) => uri.includes("/thumbnails/") && uri.endsWith(".jpg"),
    );

    library.reportThumbnailLoadFailure(created.draftId, failedPair);

    expect(library.getState()).toMatchObject({
      entries: [{ thumbnail: null, thumbnailStatus: "unavailable" }],
    });
    expect(
      [...files.files.keys()].filter((uri) => uri.includes("/thumbnails/") && uri.endsWith(".jpg")),
    ).toEqual(generatedBeforeFailure);
  });

  it("keeps a visible load failure generating while its current revision is running", async () => {
    const { files, library, setNow, setThumbnailGenerate, thumbnailSizes } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    await settleBackgroundWork();
    let markRenderStarted!: () => void;
    const renderStarted = new Promise<void>((resolve) => {
      markRenderStarted = resolve;
    });
    let releaseRender!: () => void;
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    setThumbnailGenerate(async (input) => {
      markRenderStarted();
      await renderGate;
      const square = { width: 360, height: 360 } as const;
      const original = { width: 720, height: 540 } as const;
      files.files.set(input.squareUri, new Uint8Array([7, input.contentRevision]));
      files.files.set(input.originalUri, new Uint8Array([8, input.contentRevision]));
      thumbnailSizes.set(input.squareUri, square);
      thumbnailSizes.set(input.originalUri, original);
      return { square, original };
    });
    let markRevisionTwoCommitted!: () => void;
    const revisionTwoCommitted = new Promise<void>((resolve) => {
      markRevisionTwoCommitted = resolve;
    });
    const unsubscribe = library.subscribe(() => {
      const state = library.getState();
      const entry = state.status === "ready" ? state.entries[0] : undefined;
      if (
        entry?.status === "ready" &&
        entry.contentRevision === 2 &&
        entry.thumbnail?.contentRevision === 2 &&
        entry.thumbnailStatus === "ready"
      ) {
        markRevisionTwoCommitted();
      }
    });
    setNow("2026-07-22T09:00:00.000Z");
    await expect(
      library.save(
        created.draftId,
        updateDocument(created.document, {
          canvas: { ...created.document.canvas, backgroundColor: "#454545" },
        }),
      ),
    ).resolves.toMatchObject({ status: "saved", contentRevision: 2 });
    await renderStarted;
    const generating = library.getState();
    const oldPair = generating.status === "ready" ? generating.entries[0]?.thumbnail : undefined;
    if (oldPair === undefined || oldPair === null) {
      throw new Error("expected the previous pair while revision two is generating");
    }

    library.reportThumbnailLoadFailure(created.draftId, oldPair);
    const afterFailure = library.getState();
    releaseRender();
    await revisionTwoCommitted;
    unsubscribe();

    expect(afterFailure).toMatchObject({
      entries: [
        {
          contentRevision: 2,
          thumbnail: null,
          thumbnailStatus: "generating",
        },
      ],
    });
  });

  it("drops an old thumbnail pair when a corrupt Draft cannot decode it", async () => {
    const { files, library, createLibrary } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    await settleBackgroundWork();
    await files.writeText(`${firstDraftUri}/draft.json`, "not-json");
    const restarted = createLibrary();
    const loaded = await restarted.load();
    const entry = loaded.status === "ready" ? loaded.entries[0] : undefined;
    if (entry?.status !== "corrupt" || entry.thumbnail === null) {
      throw new Error("expected a corrupt Draft with its old thumbnail pair");
    }

    restarted.reportThumbnailLoadFailure(created.draftId, entry.thumbnail);

    expect(restarted.getState()).toMatchObject({
      status: "ready",
      entries: [{ status: "corrupt", thumbnail: null }],
    });
  });

  it("separates proven corruption from retryable page-level storage failure", async () => {
    const { files, library, createLibrary, setNow } = setup();
    const first = await createDraft(library, [candidate("one")]);
    setNow("2026-07-22T09:00:00.000Z");
    const second = await createDraft(library, [candidate("two")]);
    if (first.status !== "created" || second.status !== "created") {
      throw new Error("expected two created Drafts");
    }
    const firstRootUri = `${firstDraftUri}/draft.json`;
    const secondOriginal = second.assets.resolve(second.document.sourceImages[0]!.id, "original");
    if (secondOriginal === null) throw new Error("expected second original");
    const secondRootUri = `${secondOriginal.uri.split("/assets/", 1)[0]}/draft.json`;
    await files.writeText(firstRootUri, "not-json");

    await expect(createLibrary().load()).resolves.toMatchObject({
      status: "ready",
      entries: [
        { status: "corrupt", draftId: first.draftId, updatedAt: null },
        { status: "ready", draftId: second.draftId },
      ],
    });

    const retrying = createLibrary();
    files.failReadText = secondRootUri;
    await expect(retrying.load()).resolves.toMatchObject({ status: "storage-failed" });
    expect(retrying.getState()).toMatchObject({ status: "storage-failed" });
    files.failReadText = null;
    await expect(retrying.load()).resolves.toMatchObject({
      status: "ready",
      entries: [
        { status: "corrupt", draftId: first.draftId },
        { status: "ready", draftId: second.draftId },
      ],
    });
  });

  it("commits deletion with an external marker and resolves unknown outcomes on retry", async () => {
    const failed = setup();
    const failedCreated = await createDraft(failed.library, [candidate("one")]);
    if (failedCreated.status !== "created") throw new Error("expected a created Draft");
    const markerUri = `${firstDraftUri.replace("/drafts/", "/deletions/")}.json`;
    failed.files.failWriteText = markerUri;

    await expect(failed.library.deleteDraft(failedCreated.draftId)).resolves.toMatchObject({
      status: "delete-failed",
    });
    expect(failed.library.getState()).toMatchObject({
      status: "ready",
      entries: [{ draftId: failedCreated.draftId }],
    });
    failed.files.failWriteText = null;
    await expect(failed.library.read(failedCreated.draftId)).resolves.toMatchObject({
      status: "ready",
    });

    const unknown = setup();
    const unknownCreated = await createDraft(unknown.library, [candidate("one")]);
    if (unknownCreated.status !== "created") throw new Error("expected a created Draft");
    unknown.files.failReadText = markerUri;
    await expect(unknown.library.deleteDraft(unknownCreated.draftId)).resolves.toMatchObject({
      status: "delete-unknown",
    });
    expect(unknown.library.getState()).toMatchObject({ status: "storage-failed" });
    unknown.files.failReadText = null;
    await expect(unknown.library.deleteDraft(unknownCreated.draftId)).resolves.toEqual({
      status: "deleted",
    });
    expect(unknown.library.getState()).toEqual({ status: "ready", entries: [] });
    await expect(unknown.createLibrary().load()).resolves.toEqual({
      status: "ready",
      entries: [],
    });
  });

  it("publishes one complete aggregate from the successful initial candidates", async () => {
    const { files, library } = setup();

    const created = await createDraft(library, [
      candidate("one"),
      candidate("bad"),
      candidate("two"),
    ]);

    expect(created.status).toBe("created");
    if (created.status !== "created") throw new Error("expected a created Draft");
    expect(created.errors).toEqual([
      { index: 1, sourceUri: "picker://bad.jpg", message: "preview decode failed" },
    ]);
    expect(created.document.sourceImages.map(({ id }) => id)).toEqual([
      "provider:item/../1",
      "provider:item/../3",
    ]);
    const read = await library.read(created.draftId);
    expect(read).toMatchObject({ status: "ready", document: created.document });
    expect(
      [...files.files.entries()].some(
        ([uri, value]) =>
          uri.startsWith(`${firstDraftUri}/`) &&
          value instanceof Uint8Array &&
          value[0] === 9,
      ),
    ).toBe(false);
  });

  it("never publishes failed item staging when its best-effort cleanup cannot finish", async () => {
    const { files, library } = setup();
    const originalRemoveDirectory = files.removeDirectory.bind(files);
    files.removeDirectory = async (uri) => {
      if (
        uri === "memory://library/staging/operation-1/items/item-0" ||
        uri === "memory://library/staging/operation-1"
      ) {
        throw new Error("staging cleanup busy");
      }
      await originalRemoveDirectory(uri);
    };

    const created = await createDraft(library, [candidate("bad"), candidate("two")]);

    expect(created).toMatchObject({
      status: "created",
      errors: [{ index: 0, message: "preview decode failed" }],
      document: { sourceImages: [{ id: "provider:item/../2" }] },
    });
    expect(
      [...files.files.entries()].some(
        ([uri, value]) =>
          uri.startsWith(`${firstDraftUri}/`) &&
          value instanceof Uint8Array &&
          value[0] === 9,
      ),
    ).toBe(false);
    expect(
      [...files.directories].some(
        (uri) => uri.startsWith(`${firstDraftUri}/`) && uri.includes("item-"),
      ),
    ).toBe(false);
    expect(files.directories.has("memory://library/staging/operation-1/items/item-0")).toBe(true);
  });

  it("does not allocate or expose a Draft when selection is cancelled or all items fail", async () => {
    const { library, getDraftSequence } = setup();

    await expect(createDraft(library, [])).resolves.toEqual({ status: "not-created", errors: [] });
    await expect(createDraft(library, [candidate("bad")])).resolves.toMatchObject({
      status: "not-created",
      errors: [{ index: 0, message: "preview decode failed" }],
    });
    expect(getDraftSequence()).toBe(0);
  });

  it("rolls back staging when atomic aggregate publication fails", async () => {
    const { files, library } = setup();
    files.failMoveTo = firstDraftUri;

    await expect(createDraft(library, [candidate("one")])).resolves.toEqual({
      status: "create-failed",
      message: "publication failed",
      errors: [],
    });
    await expect(library.read(draftId("draft:1"))).resolves.toEqual({
      status: "recovery-failed",
      reason: "draft-not-found",
    });
    files.failMoveTo = null;
    await expect(createDraft(library, [candidate("later")])).resolves.toMatchObject({
      status: "created",
      draftId: "draft:2",
    });
  });

  it("removes a partially copied aggregate when directory publication fails", async () => {
    const { files, library } = setup();
    files.failMoveDirectoryAfterPartialTo = firstDraftUri;

    await expect(createDraft(library, [candidate("one")])).resolves.toMatchObject({
      status: "create-failed",
      message: "directory move failed after partial copy",
    });
    files.failMoveDirectoryAfterPartialTo = null;

    await expect(library.read(draftId("draft:1"))).resolves.toEqual({
      status: "recovery-failed",
      reason: "draft-not-found",
    });
  });

  it("returns typed failures when create or ingest staging cannot be initialized", async () => {
    const first = setup();
    first.files.failEnsureDirectory =
      "memory://library/staging/operation-1/aggregate/assets";

    await expect(createDraft(first.library, [candidate("one")])).resolves.toEqual({
      status: "create-failed",
      message: "directory unavailable",
      errors: [],
    });
    expect(first.files.directories.has("memory://library/staging/operation-1")).toBe(false);

    const second = setup();
    const created = await createDraft(second.library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    second.files.failEnsureDirectory = "memory://library/staging/operation-2";
    await expect(second.library.ingest(created.draftId, [candidate("two")])).resolves.toEqual({
      status: "ingest-failed",
      imported: [],
      errors: [],
      message: "directory unavailable",
    });
  });

  it("retries storage initialization after a transient failure", async () => {
    const { files, library } = setup();
    files.failEnsureDirectory = "memory://library/drafts";

    await expect(library.read(draftId("missing"))).resolves.toEqual({
      status: "recovery-failed",
      reason: "storage-unavailable",
    });

    files.failEnsureDirectory = null;
    await expect(library.read(draftId("missing"))).resolves.toEqual({
      status: "recovery-failed",
      reason: "draft-not-found",
    });
  });

  it("does not let staging enumeration failure mask a valid Draft read or save", async () => {
    const { files, library, createLibrary } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    files.failListDirectories = "memory://library/staging";
    const restarted = createLibrary();

    await expect(restarted.read(created.draftId)).resolves.toMatchObject({ status: "ready" });
    await expect(restarted.save(created.draftId, created.document)).resolves.toMatchObject({
      status: "saved",
    });
  });

  it("recovers the previous document after replacement removes the destination and fails", async () => {
    const { files, library, createLibrary } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    const documentUri = `${firstDraftUri}/draft.json`;
    files.failMoveAfterDestinationRemovalTo = documentUri;
    const changed = updateDocument(created.document, {
      canvas: { ...created.document.canvas, backgroundColor: "#123456" },
    });

    await expect(library.save(created.draftId, changed)).resolves.toMatchObject({
      status: "save-failed",
      reason: "storage-failed",
    });
    files.failMoveAfterDestinationRemovalTo = null;

    await expect(createLibrary().read(created.draftId)).resolves.toMatchObject({
      status: "ready",
      document: created.document,
    });
  });

  it("does not roll back a valid current document when validation I/O is transient", async () => {
    const { files, library, createLibrary } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    const changed = updateDocument(created.document, {
      canvas: { ...created.document.canvas, backgroundColor: "#abcdef" },
    });
    await library.save(created.draftId, changed);
    const documentUri = `${firstDraftUri}/draft.json`;
    const currentRoot = JSON.parse(await files.readText(documentUri)) as Record<string, unknown>;
    files.files.set(
      `${documentUri}.backup`,
      JSON.stringify({
        ...currentRoot,
        contentRevision: 1,
        document: created.document,
        metadata: created.metadata,
      }),
    );
    files.failReadText = documentUri;

    await expect(createLibrary().read(created.draftId)).resolves.toEqual({
      status: "recovery-failed",
      reason: "storage-unavailable",
    });
    files.failReadText = null;

    await expect(createLibrary().read(created.draftId)).resolves.toMatchObject({
      status: "ready",
      document: changed,
    });
  });

  it("recovers the previous catalog after ingest replacement removes the destination and fails", async () => {
    const { files, library, createLibrary } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    files.failMoveAfterDestinationRemovalTo = `${firstDraftUri}/catalog.json`;

    await expect(library.ingest(created.draftId, [candidate("two")])).resolves.toMatchObject({
      status: "ingested",
      imported: [],
      errors: [{ message: "move failed after destination removal" }],
    });
    files.failMoveAfterDestinationRemovalTo = null;

    await expect(createLibrary().read(created.draftId)).resolves.toMatchObject({
      status: "ready",
      assets: { entries: created.assets.entries },
    });
  });

  it("keeps published assets when catalog replacement copied the new current before failing", async () => {
    const { files, library, createLibrary } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    files.failMoveAfterCopyTo = `${firstDraftUri}/catalog.json`;

    const result = await library.ingest(created.draftId, [candidate("two")]);

    expect(result).toMatchObject({
      status: "ingested",
      imported: [{ image: { id: "provider:item/../2" } }],
      errors: [],
    });
    files.failMoveAfterCopyTo = null;
    await expect(createLibrary().read(created.draftId)).resolves.toMatchObject({
      status: "ready",
      assets: { entries: ["provider:item/../1", "provider:item/../2"] },
    });
  });

  it("invalidates the authoritative state before unknown ingest cleanup settles", async () => {
    const { files, library } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    await settleBackgroundWork();
    const catalogUri = `${firstDraftUri}/catalog.json`;
    files.interruptMoveAfterCopyTo = catalogUri;
    const removeDirectory = files.removeDirectory.bind(files);
    let markCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let shouldPauseCleanup = true;
    files.removeDirectory = async (uri) => {
      if (
        shouldPauseCleanup &&
        uri.startsWith("memory://library/staging/operation-")
      ) {
        shouldPauseCleanup = false;
        markCleanupStarted();
        await cleanupGate;
      }
      await removeDirectory(uri);
    };

    let ingestSettled = false;
    const ingesting = library.ingest(created.draftId, [candidate("two")]);
    void ingesting.then(() => {
      ingestSettled = true;
    });
    await cleanupStarted;

    expect(ingestSettled).toBe(false);
    expect(library.getState()).toMatchObject({ status: "storage-failed" });

    releaseCleanup();
    await expect(ingesting).resolves.toMatchObject({
      status: "ingest-unknown",
      confirmed: { imported: [] },
      errors: [{ index: 0, sourceUri: "picker://two.jpg" }],
      message: "process interrupted after move copied its destination",
    });
  });

  it("preserves a partially committed ingest batch when the catalog outcome is unknown", async () => {
    const { files, library, createLibrary } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    await settleBackgroundWork();
    const catalogUri = `${firstDraftUri}/catalog.json`;
    const moveFile = files.moveFile.bind(files);
    let catalogCommitAttempts = 0;
    files.moveFile = async (sourceUri, destinationUri) => {
      if (destinationUri === catalogUri) {
        catalogCommitAttempts += 1;
        if (catalogCommitAttempts === 2) files.interruptMoveAfterCopyTo = catalogUri;
      }
      await moveFile(sourceUri, destinationUri);
    };
    const withMetadata = {
      ...candidate("later"),
      exif: { Make: "Plog Camera", Model: "Architecture Review" },
    };

    const result = await library.ingest(created.draftId, [
      candidate("two"),
      withMetadata,
      candidate("bad"),
    ]);
    expect(result).toMatchObject({
      status: "ingest-unknown",
      confirmed: {
        imported: [{ image: { id: "provider:item/../2" } }],
      },
      errors: [
        { index: 1, sourceUri: "picker://later.jpg" },
        { index: 2, sourceUri: "picker://bad.jpg" },
      ],
      message: "process interrupted after move copied its destination",
    });
    expect(result).not.toHaveProperty("assets");
    if (result.status !== "ingest-unknown") {
      throw new Error("expected an unknown catalog outcome");
    }
    expect(
      result.confirmed.resolve(importedAssetId("provider:item/../2"), "original"),
    ).toMatchObject({ assetId: "provider:item/../2" });
    expect(
      result.confirmed.resolve(importedAssetId("provider:item/../1"), "original"),
    ).toBeNull();
    expect(
      result.confirmed.resolve(importedAssetId("provider:item/../3"), "original"),
    ).toBeNull();
    expect(library.getState()).toMatchObject({ status: "storage-failed" });
    expect(
      [...files.files.keys()].filter(
        (uri) =>
          uri.startsWith(`${firstDraftUri}/`) &&
          (uri.includes("asset-2") || uri.includes("asset-3")),
      ),
    ).toEqual(
      expect.arrayContaining([
        `${firstDraftUri}/assets/asset-2.jpg`,
        `${firstDraftUri}/previews/asset-2.jpg`,
        `${firstDraftUri}/assets/asset-3.jpg`,
        `${firstDraftUri}/previews/asset-3.jpg`,
        `${firstDraftUri}/metadata/asset-3.json`,
      ]),
    );
    expect(
      [...files.files.keys()].some(
        (uri) => uri.startsWith(`${firstDraftUri}/`) && uri.includes("asset-4"),
      ),
    ).toBe(false);
    expect(files.files.has(catalogUri)).toBe(true);
    expect(files.files.has(`${catalogUri}.backup`)).toBe(true);
    expect(files.files.has(`${catalogUri}.tmp`)).toBe(true);
    expect(
      [...files.directories].some((uri) =>
        uri.startsWith("memory://library/staging/operation-"),
      ),
    ).toBe(true);

    files.storageInterrupted = false;
    const restartedLibrary = createLibrary();
    const restarted = await restartedLibrary.read(created.draftId);
    expect(restarted).toMatchObject({
      status: "ready",
      assets: {
        entries: ["provider:item/../1", "provider:item/../2", "provider:item/../3"],
      },
    });
    if (restarted.status !== "ready") throw new Error("expected a recovered Draft");
    for (const [assetId, usages] of [
      ["provider:item/../2", ["original", "preview"]],
      ["provider:item/../3", ["original", "preview", "metadata"]],
    ] as const) {
      for (const usage of usages) {
        const descriptor = restarted.assets.resolve(importedAssetId(assetId), usage);
        if (descriptor === null) throw new Error(`expected recovered ${usage} descriptor`);
        expect(files.files.has(descriptor.uri)).toBe(true);
      }
    }
    expect(files.files.has(`${catalogUri}.backup`)).toBe(false);
    expect(files.files.has(`${catalogUri}.tmp`)).toBe(false);
    expect(
      [...files.directories].some((uri) =>
        uri.startsWith("memory://library/staging/operation-"),
      ),
    ).toBe(false);

    const confirmed = result.confirmed.imported[0];
    if (confirmed === undefined) throw new Error("expected a confirmed asset");
    const documentWithConfirmedAsset = updateDocument(created.document, {
      sourceImages: [...created.document.sourceImages, confirmed.image],
      stitch: {
        ...created.document.stitch,
        order: [...created.document.stitch.order, confirmed.image.id],
      },
    });
    await expect(
      restartedLibrary.save(created.draftId, documentWithConfirmedAsset),
    ).resolves.toMatchObject({ status: "saved" });
    await restartedLibrary.maintainInactive(created.draftId);
    await expect(restartedLibrary.read(created.draftId)).resolves.toMatchObject({
      status: "ready",
      assets: {
        entries: ["provider:item/../1", "provider:item/../2"],
      },
    });
    expect(files.files.has(`${firstDraftUri}/assets/asset-2.jpg`)).toBe(true);
    expect(files.files.has(`${firstDraftUri}/previews/asset-2.jpg`)).toBe(true);
    expect(files.files.has(`${firstDraftUri}/assets/asset-3.jpg`)).toBe(false);
    expect(files.files.has(`${firstDraftUri}/previews/asset-3.jpg`)).toBe(false);
    expect(files.files.has(`${firstDraftUri}/metadata/asset-3.json`)).toBe(false);
  });

  it("keeps the confirmed prefix when restart proves that the old catalog won", async () => {
    const { files, library, createLibrary } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    await settleBackgroundWork();
    const catalogUri = `${firstDraftUri}/catalog.json`;
    const moveFile = files.moveFile.bind(files);
    let catalogCommitAttempts = 0;
    files.moveFile = async (sourceUri, destinationUri) => {
      if (destinationUri === catalogUri) {
        catalogCommitAttempts += 1;
        if (catalogCommitAttempts === 2) {
          files.interruptMoveAfterDestinationRemovalTo = catalogUri;
        }
      }
      await moveFile(sourceUri, destinationUri);
    };
    const withMetadata = {
      ...candidate("later"),
      exif: { Make: "Plog Camera", Model: "Rollback Proof" },
    };

    const result = await library.ingest(created.draftId, [
      candidate("two"),
      withMetadata,
    ]);
    expect(result).toMatchObject({
      status: "ingest-unknown",
      confirmed: {
        imported: [{ image: { id: "provider:item/../2" } }],
      },
      errors: [{ index: 1, sourceUri: "picker://later.jpg" }],
      message: "process interrupted after move removed its destination",
    });
    expect(library.getState()).toMatchObject({ status: "storage-failed" });
    const candidateUris = [
      `${firstDraftUri}/assets/asset-3.jpg`,
      `${firstDraftUri}/previews/asset-3.jpg`,
      `${firstDraftUri}/metadata/asset-3.json`,
    ];
    for (const uri of candidateUris) expect(files.files.has(uri)).toBe(true);
    expect(files.files.has(catalogUri)).toBe(false);
    expect(files.files.has(`${catalogUri}.backup`)).toBe(true);
    expect(files.files.has(`${catalogUri}.tmp`)).toBe(true);

    files.storageInterrupted = false;
    const restarted = createLibrary();
    await expect(restarted.read(created.draftId)).resolves.toMatchObject({
      status: "ready",
      assets: { entries: ["provider:item/../1", "provider:item/../2"] },
    });
    for (const uri of candidateUris) expect(files.files.has(uri)).toBe(true);
    expect(files.files.has(`${catalogUri}.backup`)).toBe(false);
    expect(files.files.has(`${catalogUri}.tmp`)).toBe(false);

    if (result.status !== "ingest-unknown") {
      throw new Error("expected an unknown catalog outcome");
    }
    const confirmed = result.confirmed.imported[0];
    if (confirmed === undefined) throw new Error("expected a confirmed asset");
    const documentWithConfirmedAsset = updateDocument(created.document, {
      sourceImages: [...created.document.sourceImages, confirmed.image],
      stitch: {
        ...created.document.stitch,
        order: [...created.document.stitch.order, confirmed.image.id],
      },
    });
    await expect(
      restarted.save(created.draftId, documentWithConfirmedAsset),
    ).resolves.toMatchObject({ status: "saved" });
    await restarted.maintainInactive(created.draftId);
    for (const uri of candidateUris) expect(files.files.has(uri)).toBe(false);
    expect(files.files.has(`${firstDraftUri}/assets/asset-2.jpg`)).toBe(true);
    expect(files.files.has(`${firstDraftUri}/previews/asset-2.jpg`)).toBe(true);
  });

  it("serializes reads and inactive maintenance behind an in-flight save for the same Draft", async () => {
    const { files, library } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    const changed = updateDocument(created.document, {
      canvas: { ...created.document.canvas, backgroundColor: "#654321" },
    });
    const originalWrite = files.writeText.bind(files);
    let enteredWrite: (() => void) | undefined;
    let releaseWrite: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredWrite = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let shouldPause = true;
    files.writeText = async (uri, content) => {
      await originalWrite(uri, content);
      if (uri === `${firstDraftUri}/draft.json.tmp` && shouldPause) {
        shouldPause = false;
        enteredWrite?.();
        await gate;
      }
    };

    const saving = library.save(created.draftId, changed);
    await entered;
    const reading = library.read(created.draftId);
    const maintaining = library.maintainInactive(created.draftId);
    releaseWrite?.();

    await expect(saving).resolves.toMatchObject({ status: "saved" });
    await expect(reading).resolves.toMatchObject({ status: "ready", document: changed });
    await expect(maintaining).resolves.toBeUndefined();
  });

  it("allows persistent operations for different Drafts to run concurrently", async () => {
    const { files, library, setNow } = setup();
    const first = await createDraft(library, [candidate("one")]);
    const second = await createDraft(library, [candidate("two")]);
    if (first.status !== "created" || second.status !== "created") {
      throw new Error("expected two created Drafts");
    }
    const firstRoot = `${firstDraftUri}/draft.json.tmp`;
    const secondOriginal = second.assets.resolve(second.document.sourceImages[0]!.id, "original");
    if (secondOriginal === null) throw new Error("expected second original");
    const secondRoot = `${secondOriginal.uri.split("/assets/", 1)[0]}/draft.json.tmp`;
    let releaseWrites!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });
    let markBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    const started = new Set<string>();
    const originalWrite = files.writeText.bind(files);
    files.writeText = async (uri, content) => {
      if (uri === firstRoot || uri === secondRoot) {
        started.add(uri);
        if (started.size === 2) markBothStarted();
        await writeGate;
      }
      await originalWrite(uri, content);
    };
    setNow("2026-07-22T10:00:00.000Z");

    const firstSave = library.save(
      first.draftId,
      updateDocument(first.document, {
        canvas: { ...first.document.canvas, backgroundColor: "#111111" },
      }),
    );
    const secondSave = library.save(
      second.draftId,
      updateDocument(second.document, {
        canvas: { ...second.document.canvas, backgroundColor: "#222222" },
      }),
    );

    await bothStarted;
    expect(started).toEqual(new Set([firstRoot, secondRoot]));
    releaseWrites();
    await expect(Promise.all([firstSave, secondSave])).resolves.toMatchObject([
      { status: "saved", contentRevision: 2 },
      { status: "saved", contentRevision: 2 },
    ]);
  });

  it("returns a committed save when another Draft installs a storage failure", async () => {
    const { files, library, createLibrary } = setup();
    const first = await createDraft(library, [candidate("one")]);
    const second = await createDraft(library, [candidate("two")]);
    if (first.status !== "created" || second.status !== "created") {
      throw new Error("expected two created Drafts");
    }
    const firstRoot = `${firstDraftUri}/draft.json`;
    const secondOriginal = second.assets.resolve(second.document.sourceImages[0]!.id, "original");
    if (secondOriginal === null) throw new Error("expected second original");
    const secondRoot = `${secondOriginal.uri.split("/assets/", 1)[0]}/draft.json`;
    let releaseCommittedRead!: () => void;
    const committedReadGate = new Promise<void>((resolve) => {
      releaseCommittedRead = resolve;
    });
    let markCommittedRead!: () => void;
    const committedRead = new Promise<void>((resolve) => {
      markCommittedRead = resolve;
    });
    const originalRead = files.readText.bind(files);
    let pauseCommittedRead = true;
    files.readText = async (uri) => {
      const value = await originalRead(uri);
      if (
        pauseCommittedRead &&
        uri === firstRoot &&
        JSON.parse(value).contentRevision === 2
      ) {
        pauseCommittedRead = false;
        markCommittedRead();
        await committedReadGate;
      }
      return value;
    };

    const saving = library.save(
      first.draftId,
      updateDocument(first.document, {
        canvas: { ...first.document.canvas, backgroundColor: "#111111" },
      }),
    );
    await committedRead;
    files.failReadText = secondRoot;
    await expect(
      library.save(
        second.draftId,
        updateDocument(second.document, {
          canvas: { ...second.document.canvas, backgroundColor: "#222222" },
        }),
      ),
    ).resolves.toMatchObject({ status: "save-failed", reason: "storage-failed" });
    files.failReadText = null;
    releaseCommittedRead();

    await expect(saving).resolves.toMatchObject({ status: "saved", contentRevision: 2 });
    expect(library.getState()).toMatchObject({ status: "storage-failed" });
    await settleBackgroundWork();
    await expect(library.load()).resolves.toMatchObject({
      status: "ready",
      entries: expect.arrayContaining([
        expect.objectContaining({
          draftId: first.draftId,
          contentRevision: 2,
          thumbnailStatus: "ready",
          thumbnail: expect.objectContaining({ contentRevision: 2 }),
        }),
      ]),
    });
    await expect(createLibrary().load()).resolves.toMatchObject({
      status: "ready",
      entries: [{ draftId: first.draftId, contentRevision: 2 }, { draftId: second.draftId }],
    });
  });

  it("returns a committed deletion when another Draft installs a storage failure", async () => {
    const { files, library, createLibrary } = setup();
    const first = await createDraft(library, [candidate("one")]);
    const second = await createDraft(library, [candidate("two")]);
    if (first.status !== "created" || second.status !== "created") {
      throw new Error("expected two created Drafts");
    }
    const markerUri = `${firstDraftUri.replace("/drafts/", "/deletions/")}.json`;
    const secondOriginal = second.assets.resolve(second.document.sourceImages[0]!.id, "original");
    if (secondOriginal === null) throw new Error("expected second original");
    const secondRoot = `${secondOriginal.uri.split("/assets/", 1)[0]}/draft.json`;
    let releaseMarkerRead!: () => void;
    const markerReadGate = new Promise<void>((resolve) => {
      releaseMarkerRead = resolve;
    });
    let markMarkerRead!: () => void;
    const markerRead = new Promise<void>((resolve) => {
      markMarkerRead = resolve;
    });
    const originalRead = files.readText.bind(files);
    let pauseMarkerRead = true;
    files.readText = async (uri) => {
      const value = await originalRead(uri);
      if (pauseMarkerRead && uri === markerUri) {
        pauseMarkerRead = false;
        markMarkerRead();
        await markerReadGate;
      }
      return value;
    };

    const deleting = library.deleteDraft(first.draftId);
    await markerRead;
    files.failReadText = secondRoot;
    await expect(
      library.save(
        second.draftId,
        updateDocument(second.document, {
          canvas: { ...second.document.canvas, backgroundColor: "#222222" },
        }),
      ),
    ).resolves.toMatchObject({ status: "save-failed", reason: "storage-failed" });
    files.failReadText = null;
    releaseMarkerRead();

    await expect(deleting).resolves.toEqual({ status: "deleted" });
    expect(library.getState()).toMatchObject({ status: "storage-failed" });
    await expect(createLibrary().load()).resolves.toMatchObject({
      status: "ready",
      entries: [{ draftId: second.draftId }],
    });
  });

  it("merges a committed creation into a retry load that enumerated before publication", async () => {
    const { files, library } = setup();
    const existing = await createDraft(library, [candidate("one")]);
    if (existing.status !== "created") throw new Error("expected an existing Draft");
    let releasePublication!: () => void;
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    let markPublicationReady!: () => void;
    const publicationReady = new Promise<void>((resolve) => {
      markPublicationReady = resolve;
    });
    const originalDirectoryExists = files.directoryExists.bind(files);
    let pausePublication = true;
    files.directoryExists = async (uri) => {
      if (
        pausePublication &&
        uri.startsWith("memory://library/drafts/") &&
        uri !== firstDraftUri
      ) {
        pausePublication = false;
        markPublicationReady();
        await publicationGate;
      }
      return originalDirectoryExists(uri);
    };
    const creating = createDraft(library, [candidate("two")]);
    await publicationReady;

    files.failReadText = `${firstDraftUri}/draft.json`;
    await expect(
      library.save(
        existing.draftId,
        updateDocument(existing.document, {
          canvas: { ...existing.document.canvas, backgroundColor: "#111111" },
        }),
      ),
    ).resolves.toMatchObject({ status: "save-failed", reason: "storage-failed" });
    files.failReadText = null;
    let releaseEnumeration!: () => void;
    const enumerationGate = new Promise<void>((resolve) => {
      releaseEnumeration = resolve;
    });
    let markEnumerationCaptured!: () => void;
    const enumerationCaptured = new Promise<void>((resolve) => {
      markEnumerationCaptured = resolve;
    });
    const originalListDirectories = files.listDirectories.bind(files);
    let pauseEnumeration = true;
    files.listDirectories = async (uri) => {
      const result = await originalListDirectories(uri);
      if (pauseEnumeration && uri === "memory://library/drafts") {
        pauseEnumeration = false;
        markEnumerationCaptured();
        await enumerationGate;
      }
      return result;
    };

    const reloading = library.load();
    await enumerationCaptured;
    releasePublication();
    await expect(creating).resolves.toMatchObject({ status: "created", draftId: "draft:2" });
    await settleBackgroundWork();
    releaseEnumeration();

    await expect(reloading).resolves.toMatchObject({
      status: "ready",
      entries: expect.arrayContaining([
        expect.objectContaining({
          draftId: "draft:2",
          thumbnailStatus: "ready",
          thumbnail: expect.objectContaining({ contentRevision: 1 }),
        }),
        expect.objectContaining({ draftId: existing.draftId }),
      ]),
    });
  });

  it("reports item staging failure per candidate and continues the ingest batch", async () => {
    const { files, library } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    files.failEnsureDirectory = "memory://library/staging/operation-2/item-0";

    const result = await library.ingest(created.draftId, [candidate("bad"), candidate("two")]);

    expect(result).toMatchObject({
      status: "ingested",
      imported: [{ image: { id: "provider:item/../2" } }],
      errors: [{ index: 0, message: "directory unavailable" }],
    });
  });

  it("reuses an uncommitted identity and storage key after a candidate fails", async () => {
    const { files, previews, thumbnails } = setup();
    const library = createDraftLibrary({
      files,
      previews,
      thumbnails,
      rootUri: "memory://library",
      createAssetId: () => importedAssetId("same:asset"),
      createStorageKey: () => "same-storage-key",
      createOperationId: () => "same-operation",
      createDraftId: () => draftId("draft:same"),
    });

    const created = await createDraft(library, [candidate("bad"), candidate("two")]);

    expect(created).toMatchObject({
      status: "created",
      document: { sourceImages: [{ id: "same:asset" }] },
      errors: [{ index: 0, message: "preview decode failed" }],
    });
  });

  it("reads an immutable draft-scoped catalog and resolves local descriptors synchronously", async () => {
    const { library } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");

    const original = created.assets.resolve(importedAssetId("provider:item/../1"), "original");

    expect(Object.isFrozen(created.assets)).toBe(true);
    expect(Object.isFrozen(created.assets.entries)).toBe(true);
    expect(original).toMatchObject({
      draftId: "draft:1",
      assetId: "provider:item/../1",
      usage: "original",
    });
    expect(original?.uri).not.toContain("provider:item/../1");
    expect(created.assets.resolve(importedAssetId("another-draft-asset"), "original")).toBeNull();
  });

  it("maps traversal-like opaque Draft identity to an owned path-safe storage directory", async () => {
    const { files, previews, thumbnails } = setup();
    const library = createDraftLibrary({
      files,
      previews,
      thumbnails,
      rootUri: "memory://library",
      createAssetId: () => importedAssetId("asset:opaque"),
      createStorageKey: () => "safe-asset-key",
      createOperationId: () => "safe-operation-key",
      createDraftId: () => draftId("../draft:opaque"),
    });

    const created = await createDraft(library, [candidate("one")]);

    expect(created).toMatchObject({ status: "created", draftId: "../draft:opaque" });
    if (created.status !== "created") throw new Error("expected a created Draft");
    const original = created.assets.resolve(importedAssetId("asset:opaque"), "original");
    expect(original?.uri).toContain(
      "/drafts/draft-AC4ALgAvAGQAcgBhAGYAdAA6AG8AcABhAHEAdQBl/",
    );
    expect(original?.uri).not.toMatch(/\/drafts\/[^/]*[.%][^/]*\//);
    await expect(library.read(created.draftId)).resolves.toMatchObject({ status: "ready" });
  });

  it("atomically saves a document only when every asset belongs to the target Draft", async () => {
    const { files, library } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    const changed = updateDocument(created.document, {
      canvas: { ...created.document.canvas, backgroundColor: "#112233" },
    });

    await expect(library.save(created.draftId, changed)).resolves.toMatchObject({
      status: "saved",
      document: changed,
    });
    await expect(library.read(created.draftId)).resolves.toMatchObject({
      status: "ready",
      document: changed,
    });

    const foreign = updateDocument(changed, {
      sourceImages: [
        { id: importedAssetId("foreign:asset"), width: 10, height: 10 },
      ],
      stitch: { ...changed.stitch, order: [importedAssetId("foreign:asset")] },
    });
    await expect(library.save(created.draftId, foreign)).resolves.toEqual({
      status: "save-failed",
      reason: "asset-reference-missing",
    });

    const changedFacts = updateDocument(changed, {
      sourceImages: [{ ...changed.sourceImages[0]!, width: 999 }],
    });
    await expect(library.save(created.draftId, changedFacts)).resolves.toEqual({
      status: "save-failed",
      reason: "asset-facts-mismatch",
    });

    files.failMoveTo = `${firstDraftUri}/draft.json`;
    const rejected = updateDocument(changed, {
      canvas: { ...changed.canvas, backgroundColor: "#445566" },
    });
    await expect(library.save(created.draftId, rejected)).resolves.toMatchObject({
      status: "save-failed",
      reason: "storage-failed",
    });
    files.failMoveTo = null;
    await expect(library.read(created.draftId)).resolves.toMatchObject({
      status: "ready",
      document: changed,
    });
  });

  it("returns typed recovery failures without requiring optional metadata", async () => {
    const { files, library } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    const original = created.assets.resolve(created.document.sourceImages[0]!.id, "original");
    if (original === null) throw new Error("expected original descriptor");

    const metadata = created.assets.resolve(created.document.sourceImages[0]!.id, "metadata");
    if (metadata !== null) await files.removeFile(metadata.uri);
    await expect(library.read(created.draftId)).resolves.toMatchObject({ status: "ready" });

    await files.removeFile(original.uri);
    await expect(library.read(created.draftId)).resolves.toEqual({
      status: "recovery-failed",
      reason: "original-missing",
    });
  });

  it.each([
    ["draft.json", "document-corrupt"],
    ["catalog.json", "catalog-corrupt"],
  ] as const)("classifies a published Draft with missing %s", async (fileName, reason) => {
    const { files, library } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    await files.removeFile(`${firstDraftUri}/${fileName}`);

    await expect(library.read(created.draftId)).resolves.toEqual({
      status: "recovery-failed",
      reason,
    });
  });

  it.each([
    ["draft.json"],
    ["catalog.json"],
  ] as const)("maps a wrong filesystem node at %s to typed recovery", async (fileName) => {
    const { files, library } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    files.failFileExists = `${firstDraftUri}/${fileName}`;

    await expect(library.read(created.draftId)).resolves.toEqual({
      status: "recovery-failed",
      reason: "storage-unavailable",
    });
  });

  it("maps a wrong filesystem node at an original path to typed failures", async () => {
    const { files, library } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    const image = created.document.sourceImages[0]!;
    const original = created.assets.resolve(image.id, "original");
    if (original === null) throw new Error("expected original descriptor");
    files.failFileExists = original.uri;

    await expect(library.read(created.draftId)).resolves.toEqual({
      status: "recovery-failed",
      reason: "storage-unavailable",
    });
    await expect(library.save(created.draftId, created.document)).resolves.toMatchObject({
      status: "save-failed",
      reason: "storage-failed",
    });
    await expect(library.readPreview(created.draftId, image.id)).resolves.toEqual({
      status: "preview-failed",
      reason: "storage-unavailable",
    });
  });

  it("keeps a late catalog I/O failure distinct from corruption while reading a preview", async () => {
    const { files, library } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    await settleBackgroundWork();
    const image = created.document.sourceImages[0]!;
    files.failReadTextAfter = {
      uri: `${firstDraftUri}/catalog.json`,
      remainingSuccessfulCalls: 2,
    };

    await expect(library.readPreview(created.draftId, image.id)).resolves.toMatchObject({
      status: "preview-failed",
      reason: "storage-unavailable",
    });
  });

  it("keeps a late original probe failure distinct from a missing original", async () => {
    const { files, library } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    await settleBackgroundWork();
    const image = created.document.sourceImages[0]!;
    const original = created.assets.resolve(image.id, "original");
    if (original === null) throw new Error("expected an original descriptor");
    files.failFileExistsAfter = {
      uri: original.uri,
      remainingSuccessfulCalls: 1,
    };

    await expect(library.readPreview(created.draftId, image.id)).resolves.toMatchObject({
      status: "preview-failed",
      reason: "storage-unavailable",
    });
  });

  it("reopens from the owned immutable original after the picker source disappears", async () => {
    const { files, library } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");

    await files.removeFile("picker://one.jpg");

    await expect(library.read(created.draftId)).resolves.toMatchObject({
      status: "ready",
      document: created.document,
    });
  });

  it("rejects a corrupt catalog and an unresolved document reference", async () => {
    const { files, library } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    const documentUri = `${firstDraftUri}/draft.json`;
    const catalogUri = `${firstDraftUri}/catalog.json`;

    const originalCatalog = await files.readText(catalogUri);
    await files.writeText(catalogUri, "not-json");
    await expect(library.read(created.draftId)).resolves.toEqual({
      status: "recovery-failed",
      reason: "catalog-corrupt",
    });

    await files.writeText(catalogUri, originalCatalog);
    const unresolved = updateDocument(created.document, {
      sourceImages: [{ id: importedAssetId("missing"), width: 1, height: 1 }],
      stitch: { ...created.document.stitch, order: [importedAssetId("missing")] },
    });
    const root = JSON.parse(await files.readText(documentUri)) as Record<string, unknown>;
    await files.writeText(documentUri, JSON.stringify({ ...root, document: unresolved }));
    expect(
      parseDocumentJson(
        JSON.stringify(
          (JSON.parse(await files.readText(documentUri)) as Record<string, unknown>).document,
        ),
      ),
    ).toEqual(unresolved);
    await expect(library.read(created.draftId)).resolves.toEqual({
      status: "recovery-failed",
      reason: "asset-reference-missing",
    });
  });

  it("rejects duplicate asset identities and storage keys in a catalog", async () => {
    const { files, library } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    const catalogUri = `${firstDraftUri}/catalog.json`;
    const catalog = JSON.parse(await files.readText(catalogUri)) as {
      entries: Record<string, unknown>[];
    };
    const first = catalog.entries[0];
    if (first === undefined) throw new Error("expected catalog entry");

    await files.writeText(
      catalogUri,
      JSON.stringify({ ...catalog, entries: [first, { ...first, storageKey: "another-key" }] }),
    );
    await expect(library.read(created.draftId)).resolves.toEqual({
      status: "recovery-failed",
      reason: "catalog-corrupt",
    });

    await files.writeText(
      catalogUri,
      JSON.stringify({
        ...catalog,
        entries: [first, { ...first, id: "another:asset" }],
      }),
    );
    await expect(library.read(created.draftId)).resolves.toEqual({
      status: "recovery-failed",
      reason: "catalog-corrupt",
    });
  });

  it("ingests candidates with partial success and publishes assets before a new catalog snapshot", async () => {
    const { library } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    const originalSnapshot = created.assets;

    const result = await library.ingest(created.draftId, [candidate("bad"), candidate("two")]);

    expect(result).toMatchObject({
      status: "ingested",
      imported: [{ image: { id: "provider:item/../3", width: 4000, height: 3000 } }],
      errors: [{ index: 0, sourceUri: "picker://bad.jpg", message: "preview decode failed" }],
    });
    if (result.status !== "ingested") throw new Error("expected an ingested batch");
    expect(originalSnapshot.entries).toEqual(["provider:item/../1"]);
    expect(result.assets.entries).toEqual(["provider:item/../1", "provider:item/../3"]);
    expect(
      result.assets.resolve(importedAssetId("provider:item/../3"), "original"),
    ).toMatchObject({ usage: "original" });
  });

  it("rolls back candidate files and recovers the catalog when ingest publication fails", async () => {
    const { files, library, createLibrary } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    files.failMoveTo = `${firstDraftUri}/catalog.json`;

    const result = await library.ingest(created.draftId, [candidate("two")]);

    expect(result).toMatchObject({
      status: "ingested",
      imported: [],
      errors: [{ index: 0, message: "publication failed" }],
      assets: { entries: ["provider:item/../1"] },
    });
    expect(
      [...files.files.keys()].some(
        (uri) => uri.startsWith(`${firstDraftUri}/`) && uri.includes("asset-2"),
      ),
    ).toBe(false);
    files.failMoveTo = null;
    await expect(createLibrary().read(created.draftId)).resolves.toMatchObject({
      status: "ready",
      assets: { entries: created.assets.entries },
    });
  });

  it("does not alter the immutable original while rebuilding a missing or corrupt preview", async () => {
    const { files, library } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    const assetId = created.document.sourceImages[0]!.id;
    const original = created.assets.resolve(assetId, "original");
    const preview = created.assets.resolve(assetId, "preview");
    if (original === null || preview === null) throw new Error("expected asset descriptors");
    const originalBytes = files.files.get(original.uri);

    await files.removeFile(preview.uri);
    const rebuiltMissing = await library.readPreview(created.draftId, assetId);
    expect(rebuiltMissing).toMatchObject({
      status: "ready",
      descriptor: { assetId, usage: "preview", uri: preview.uri },
    });
    if (rebuiltMissing.status !== "ready") throw new Error("expected rebuilt preview");
    expect(rebuiltMissing.assets).not.toBe(created.assets);
    expect(files.files.get(original.uri)).toBe(originalBytes);

    files.files.set(preview.uri, new Uint8Array([0]));
    await expect(library.readPreview(created.draftId, assetId)).resolves.toMatchObject({
      status: "ready",
      descriptor: { uri: preview.uri },
    });
    expect(files.files.get(original.uri)).toBe(originalBytes);
  });

  it("recovers a rebuilt preview after replacement removes the destination and fails", async () => {
    const { files, library, createLibrary } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    const assetId = created.document.sourceImages[0]!.id;
    const preview = created.assets.resolve(assetId, "preview");
    if (preview === null) throw new Error("expected preview descriptor");
    files.files.set(preview.uri, new Uint8Array([0]));
    files.failMoveAfterDestinationRemovalTo = preview.uri;

    await expect(library.readPreview(created.draftId, assetId)).resolves.toMatchObject({
      status: "preview-failed",
    });
    files.failMoveAfterDestinationRemovalTo = null;

    await expect(createLibrary().readPreview(created.draftId, assetId)).resolves.toMatchObject({
      status: "ready",
      descriptor: { uri: preview.uri },
    });
  });

  it("keeps ordinary reads non-destructive and compacts only during explicit inactive maintenance", async () => {
    const { files, library } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    const ingested = await library.ingest(created.draftId, [candidate("two")]);
    if (ingested.status !== "ingested") throw new Error("expected an ingested batch");
    const removed = ingested.imported[0]?.image;
    if (removed === undefined) throw new Error("expected an ingested asset");
    const removedOriginal = ingested.assets.resolve(removed.id, "original");
    if (removedOriginal === null) throw new Error("expected original descriptor");
    const latest = updateDocument(created.document, {
      canvas: { ...created.document.canvas, backgroundColor: "#112233" },
    });
    await expect(library.save(created.draftId, latest)).resolves.toMatchObject({ status: "saved" });

    const inspected = await library.read(created.draftId);
    expect(inspected).toMatchObject({ status: "ready", document: latest });
    if (inspected.status !== "ready") throw new Error("expected inspected Draft");
    expect(inspected.assets.entries).toContain(removed.id);
    expect(files.files.has(removedOriginal.uri)).toBe(true);

    await library.maintainInactive(created.draftId);
    const reopened = await library.read(created.draftId);
    if (reopened.status !== "ready") throw new Error("expected reopened Draft");
    expect(reopened.assets.entries).toEqual(created.assets.entries);
    expect(files.files.has(removedOriginal.uri)).toBe(false);
  });

  it("commits the compacted catalog before best-effort deletion and cleans crash staging once", async () => {
    const { files, library, createLibrary } = setup();
    const created = await createDraft(library, [candidate("one"), candidate("two")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    const removed = created.document.sourceImages[1]!;
    const removedOriginal = created.assets.resolve(removed.id, "original");
    if (removedOriginal === null) throw new Error("expected original descriptor");
    const latest = updateDocument(created.document, {
      sourceImages: [created.document.sourceImages[0]!],
      stitch: { ...created.document.stitch, order: [created.document.sourceImages[0]!.id] },
    });
    await library.save(created.draftId, latest);
    files.directories.add("memory://library/staging/crash-operation");
    files.files.set("memory://library/staging/crash-operation/partial", "partial");
    const originalRemove = files.removeFile.bind(files);
    files.removeFile = async (uri) => {
      if (uri === removedOriginal.uri) throw new Error("device refused deletion");
      await originalRemove(uri);
    };

    const restarted = createLibrary();
    await restarted.maintainInactive(created.draftId);
    const reopened = await restarted.read(created.draftId);

    expect(reopened).toMatchObject({ status: "ready" });
    if (reopened.status !== "ready") throw new Error("expected reopened Draft");
    expect(reopened.assets.entries).not.toContain(removed.id);
    expect(files.files.has(removedOriginal.uri)).toBe(true);
    expect(files.files.has("memory://library/staging/crash-operation/partial")).toBe(false);

    files.removeFile = originalRemove;
    await restarted.maintainInactive(created.draftId);
    expect(files.files.has(removedOriginal.uri)).toBe(false);
  });

  it("sweeps direct-child ingest and preview orphans from a valid inactive Draft", async () => {
    const { files, library } = setup();
    const created = await createDraft(library, [candidate("one")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    const orphanUris = [
      `${firstDraftUri}/assets/orphan.jpg`,
      `${firstDraftUri}/previews/orphan.jpg.rebuild.tmp`,
      `${firstDraftUri}/metadata/orphan.json`,
    ];
    for (const uri of orphanUris) files.files.set(uri, "orphan");
    files.files.set(`${firstDraftUri}/assets/nested/leave-alone.jpg`, "outside direct children");

    await library.maintainInactive(created.draftId);

    for (const uri of orphanUris) expect(files.files.has(uri)).toBe(false);
    expect(files.files.has(`${firstDraftUri}/assets/nested/leave-alone.jpg`)).toBe(true);
  });

  it("does not compact a Draft that fails recovery validation", async () => {
    const { files, library, createLibrary } = setup();
    const created = await createDraft(library, [candidate("one"), candidate("two")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    const live = created.document.sourceImages[0]!;
    const stale = created.document.sourceImages[1]!;
    const liveOriginal = created.assets.resolve(live.id, "original");
    const staleOriginal = created.assets.resolve(stale.id, "original");
    if (liveOriginal === null || staleOriginal === null) throw new Error("expected descriptors");
    const latest = updateDocument(created.document, {
      sourceImages: [live],
      stitch: { ...created.document.stitch, order: [live.id] },
    });
    await library.save(created.draftId, latest);
    await files.removeFile(liveOriginal.uri);
    const orphanUri = `${firstDraftUri}/previews/orphan.tmp`;
    files.files.set(orphanUri, "orphan");

    const restarted = createLibrary();
    await restarted.maintainInactive(created.draftId);
    await expect(restarted.read(created.draftId)).resolves.toEqual({
      status: "recovery-failed",
      reason: "original-missing",
    });
    expect(await files.readText(`${firstDraftUri}/catalog.json`)).toContain(stale.id);
    expect(files.files.has(staleOriginal.uri)).toBe(true);
    expect(files.files.has(orphanUri)).toBe(true);
  });

  it("keeps a valid Draft readable when compaction commit or crash cleanup cannot finish", async () => {
    const first = setup();
    const created = await createDraft(first.library, [candidate("one"), candidate("two")]);
    if (created.status !== "created") throw new Error("expected a created Draft");
    const stale = created.document.sourceImages[1]!;
    const staleOriginal = created.assets.resolve(stale.id, "original");
    if (staleOriginal === null) throw new Error("expected descriptor");
    const latest = updateDocument(created.document, {
      sourceImages: [created.document.sourceImages[0]!],
      stitch: { ...created.document.stitch, order: [created.document.sourceImages[0]!.id] },
    });
    await first.library.save(created.draftId, latest);
    first.files.directories.add("memory://library/staging/crash-operation");
    first.files.files.set("memory://library/staging/crash-operation/partial", "partial");
    const originalRemove = first.files.removeDirectory.bind(first.files);
    first.files.removeDirectory = async (uri) => {
      if (uri === "memory://library/staging/crash-operation") throw new Error("cleanup busy");
      await originalRemove(uri);
    };
    first.files.failMoveTo = `${firstDraftUri}/catalog.json`;

    const restarted = first.createLibrary();
    await restarted.maintainInactive(created.draftId);
    first.files.failMoveTo = null;
    const reopened = await restarted.read(created.draftId);

    expect(reopened).toMatchObject({ status: "ready", document: latest });
    if (reopened.status !== "ready") throw new Error("expected valid Draft");
    expect(reopened.assets.entries).toContain(stale.id);
    expect(first.files.files.has(staleOriginal.uri)).toBe(true);
  });
});

export function updateDocument(
  document: PlogDocument,
  update: Partial<PlogDocument>,
): PlogDocument {
  return { ...document, ...update };
}
