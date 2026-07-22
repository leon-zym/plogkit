import {
  createDocument,
  importedAssetId,
  type ImportedAssetId,
  type PlogDocument,
} from "@/core/document";
import { editIntents } from "@/core/editing";
import {
  draftId,
  type AssetCatalogSnapshot,
  type AssetUsage,
  type DraftId,
  type DraftLibrary,
  type DeleteDraftResult,
  type ImportCandidate,
  type IngestAssetsResult,
  type ReadDraftResult,
  type ReadPreviewResult,
  type SaveDraftResult,
} from "@/services/drafts/draftLibrary";

import { createCurrentEditingSession } from "../currentEditingSession";

const firstDraftId = draftId("draft:first");
const secondDraftId = draftId("draft:second");
const firstImageId = importedAssetId("asset:first");
const secondImageId = importedAssetId("asset:second");
const draftVersionFacts = {
  metadata: {
    createdAt: "2026-07-22T08:00:00.000Z",
    updatedAt: "2026-07-22T08:00:00.000Z",
  },
  contentRevision: 1,
} as const;

function createAssets(id: DraftId, imageIds: readonly string[]): AssetCatalogSnapshot {
  const entries = Object.freeze(imageIds.map(importedAssetId));
  return Object.freeze({
    entries,
    resolve: (assetId: ImportedAssetId, usage: AssetUsage) =>
      entries.includes(assetId)
        ? Object.freeze({ id, draftId: id, assetId, usage, uri: `memory://${id}/${assetId}/${usage}` })
        : null,
  });
}

function createDraftDocument(imageId = firstImageId): PlogDocument {
  return createDocument([{ id: imageId, width: 1200, height: 800 }]);
}

function candidate(uri: string): ImportCandidate {
  return { uri, width: 800, height: 600, kind: "image" };
}

class MemoryDraftLibrary implements DraftLibrary {
  readonly aggregates = new Map<
    DraftId,
    { document: PlogDocument; assets: AssetCatalogSnapshot }
  >();
  readonly readCalls: DraftId[] = [];
  readonly maintenanceCalls: DraftId[] = [];
  readonly throwingReads = new Set<DraftId>();
  readonly throwingMaintenance = new Set<DraftId>();
  readonly saveCalls: { id: DraftId; document: PlogDocument }[] = [];
  readonly deleteCalls: DraftId[] = [];
  readonly readGates = new Map<DraftId, Promise<void>>();
  saveResult: SaveDraftResult | null = null;
  previewResult: ReadPreviewResult | null = null;
  saveImplementation:
    | ((id: DraftId, document: PlogDocument) => Promise<SaveDraftResult>)
    | null = null;
  ingestImplementation:
    | ((id: DraftId, candidates: readonly ImportCandidate[]) => Promise<IngestAssetsResult>)
    | null = null;
  deleteResult: DeleteDraftResult = { status: "deleted" };

  async load() {
    return { status: "ready" as const, entries: Object.freeze([]) };
  }

  getState() {
    return { status: "ready" as const, entries: Object.freeze([]) };
  }

  subscribe() {
    return () => undefined;
  }

  reportThumbnailLoadFailure() {}

  async deleteDraft(id: DraftId) {
    this.deleteCalls.push(id);
    if (this.deleteResult.status === "deleted") this.aggregates.delete(id);
    return this.deleteResult;
  }

  async create() {
    return { status: "not-created" as const, errors: [] };
  }

  async read(id: DraftId): Promise<ReadDraftResult> {
    this.readCalls.push(id);
    await this.readGates.get(id);
    if (this.throwingReads.has(id)) throw new Error("storage unavailable");
    const aggregate = this.aggregates.get(id);
    return aggregate === undefined
      ? { status: "recovery-failed", reason: "draft-not-found" }
      : { status: "ready", draftId: id, ...draftVersionFacts, ...aggregate };
  }

  async maintainInactive(id: DraftId): Promise<void> {
    this.maintenanceCalls.push(id);
    if (this.throwingMaintenance.has(id)) throw new Error("maintenance unavailable");
  }

  async save(id: DraftId, document: PlogDocument): Promise<SaveDraftResult> {
    this.saveCalls.push({ id, document });
    if (this.saveImplementation !== null) return this.saveImplementation(id, document);
    if (this.saveResult !== null) return this.saveResult;
    const aggregate = this.aggregates.get(id);
    if (aggregate === undefined) return { status: "save-failed", reason: "draft-not-found" };
    this.aggregates.set(id, { ...aggregate, document });
    return { status: "saved", ...draftVersionFacts, document };
  }

  async ingest(id: DraftId, candidates: readonly ImportCandidate[]) {
    return this.ingestImplementation === null
      ? { status: "ingested" as const, imported: [], errors: [] }
      : this.ingestImplementation(id, candidates);
  }

  async readPreview() {
    return (
      this.previewResult ?? {
        status: "preview-failed" as const,
        reason: "preview-unavailable" as const,
      }
    );
  }
}

function setup(autosaveDelayMs = 0) {
  const library = new MemoryDraftLibrary();
  library.aggregates.set(firstDraftId, {
    document: createDraftDocument(),
    assets: createAssets(firstDraftId, [firstImageId]),
  });
  library.aggregates.set(secondDraftId, {
    document: createDraftDocument(secondImageId),
    assets: createAssets(secondDraftId, [secondImageId]),
  });
  return { library, session: createCurrentEditingSession({ library, autosaveDelayMs }) };
}

describe("current editing session", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("opens a valid Draft and binds editing and assets to one stable handle", async () => {
    const { session } = setup();

    const result = await session.open(firstDraftId);

    expect(result.status).toBe("opened");
    if (result.status !== "opened") return;
    expect(result.handle.draftId).toBe(firstDraftId);
    expect(result.handle.editing.read().document.sourceImages[0]?.id).toBe(firstImageId);
    expect(result.handle.assets.resolve(firstImageId, "original")?.draftId).toBe(firstDraftId);
  });

  it("flushes and permanently invalidates the current handle before deleting its Draft", async () => {
    const { library, session } = setup(10_000);
    const opened = await session.open(firstDraftId);
    if (opened.status !== "opened") throw new Error("expected an open session");
    opened.handle.editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#123456"),
    });

    await expect(session.delete(firstDraftId)).resolves.toEqual({ status: "deleted" });
    expect(library.saveCalls.at(-1)?.document.canvas.backgroundColor).toBe("#123456");
    expect(library.deleteCalls).toEqual([firstDraftId]);
    expect(
      opened.handle.editing.dispatch({
        type: "commit",
        intent: editIntents.canvas.changeBackground("#654321"),
      }),
    ).toEqual({ status: "unavailable", reason: "session-inactive" });
  });

  it("waits for an in-flight asset transaction, flushes its committed document, then deletes", async () => {
    const { library, session } = setup(10_000);
    const opened = await session.open(firstDraftId);
    if (opened.status !== "opened") throw new Error("expected an open session");
    const addedId = importedAssetId("asset:pending-delete");
    const events: string[] = [];
    let releaseIngest!: () => void;
    const ingestGate = new Promise<void>((resolve) => {
      releaseIngest = resolve;
    });
    let markIngestStarted!: () => void;
    const ingestStarted = new Promise<void>((resolve) => {
      markIngestStarted = resolve;
    });
    library.ingestImplementation = async () => {
      events.push("ingest-started");
      markIngestStarted();
      await ingestGate;
      events.push("ingest-published");
      return {
        status: "ingested",
        imported: [
          {
            image: { id: addedId, width: 800, height: 600 },
            sourceKind: "image",
          },
        ],
        errors: [],
        assets: createAssets(firstDraftId, [firstImageId, addedId]),
      };
    };
    library.saveImplementation = async (_id, document) => {
      events.push("save");
      return {
        status: "saved",
        document,
        metadata: {
          createdAt: "2026-07-22T08:00:00.000Z",
          updatedAt: "2026-07-22T09:00:00.000Z",
        },
        contentRevision: 2,
      };
    };
    const deleteDraft = library.deleteDraft.bind(library);
    jest.spyOn(library, "deleteDraft").mockImplementation(async (id) => {
      events.push("delete");
      return deleteDraft(id);
    });

    const adding = opened.handle.addImages([candidate("picker://pending-delete.jpg")]);
    await ingestStarted;
    const deleting = session.delete(firstDraftId);
    expect(
      opened.handle.editing.dispatch({
        type: "commit",
        intent: editIntents.canvas.changeBackground("#654321"),
      }),
    ).toEqual({ status: "unavailable", reason: "session-inactive" });
    expect(library.deleteCalls).toEqual([]);

    releaseIngest();
    await expect(adding).resolves.toMatchObject({ status: "completed" });
    await expect(deleting).resolves.toEqual({ status: "deleted" });

    expect(events).toEqual(["ingest-started", "ingest-published", "save", "delete"]);
    expect(library.saveCalls.at(-1)?.document.sourceImages.map(({ id }) => id)).toEqual([
      firstImageId,
      addedId,
    ]);
  });

  it("restores the current session after a definite delete failure and freezes it while unknown", async () => {
    const first = setup(10_000);
    const opened = await first.session.open(firstDraftId);
    if (opened.status !== "opened") throw new Error("expected an open session");
    opened.handle.editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#123456"),
    });
    first.library.saveResult = { status: "save-failed", reason: "storage-failed" };

    await expect(first.session.delete(firstDraftId)).resolves.toMatchObject({
      status: "delete-failed",
      reason: "flush-failed",
    });
    expect(first.library.deleteCalls).toEqual([]);
    expect(
      opened.handle.editing.dispatch({
        type: "commit",
        intent: editIntents.canvas.changeBackground("#234567"),
      }),
    ).toMatchObject({ status: "changed" });
    first.library.saveResult = null;
    await expect(first.session.flush()).resolves.toEqual({ status: "flushed" });

    const second = setup();
    const unknownOpened = await second.session.open(firstDraftId);
    if (unknownOpened.status !== "opened") throw new Error("expected an open session");
    second.library.deleteResult = { status: "delete-unknown" };
    await expect(second.session.delete(firstDraftId)).resolves.toEqual({
      status: "delete-unknown",
    });
    expect(
      unknownOpened.handle.editing.dispatch({
        type: "commit",
        intent: editIntents.canvas.changeBackground("#345678"),
      }),
    ).toEqual({ status: "unavailable", reason: "session-inactive" });
    second.library.deleteResult = { status: "deleted" };
    await expect(second.session.delete(firstDraftId)).resolves.toEqual({ status: "deleted" });
  });

  it("returns the same handle for an idempotent open without reading the active Draft", async () => {
    const { library, session } = setup();
    const first = await session.open(firstDraftId);
    library.readCalls.length = 0;

    const second = await session.open(firstDraftId);

    expect(first.status).toBe("opened");
    expect(second.status).toBe("opened");
    if (first.status !== "opened" || second.status !== "opened") return;
    expect(second.handle).toBe(first.handle);
    expect(library.readCalls).toEqual([]);
  });

  it("keeps low-cost open independent from preview decoding", async () => {
    const { library, session } = setup();
    const readPreview = jest.spyOn(library, "readPreview");

    expect((await session.open(firstDraftId)).status).toBe("opened");

    expect(readPreview).not.toHaveBeenCalled();
  });

  it("atomically switches only after the target Draft is readable", async () => {
    const { library, session } = setup();
    const first = await session.open(firstDraftId);
    const switched = await session.open(secondDraftId);

    expect(first.status).toBe("opened");
    expect(switched.status).toBe("opened");
    if (first.status !== "opened" || switched.status !== "opened") return;
    expect(switched.handle).not.toBe(first.handle);
    expect(switched.handle.draftId).toBe(secondDraftId);
    expect(library.readCalls).toEqual([firstDraftId, secondDraftId]);
    expect(library.maintenanceCalls).toEqual([firstDraftId, secondDraftId, firstDraftId]);
  });

  it("does not turn best-effort old-Draft compaction failure into a failed switch", async () => {
    const { library, session } = setup();
    await session.open(firstDraftId);
    library.throwingMaintenance.add(firstDraftId);

    const switched = await session.open(secondDraftId);

    expect(switched.status).toBe("opened");
    if (switched.status !== "opened") return;
    expect(switched.handle.draftId).toBe(secondDraftId);
  });

  it("preserves the original handle when the target Draft cannot open", async () => {
    const { library, session } = setup();
    const first = await session.open(firstDraftId);

    const failed = await session.open(draftId("draft:missing"));
    const reopened = await session.open(firstDraftId);

    expect(failed).toEqual({ status: "open-failed", reason: "draft-not-found" });
    expect(first.status).toBe("opened");
    expect(reopened.status).toBe("opened");
    if (first.status !== "opened" || reopened.status !== "opened") return;
    expect(reopened.handle).toBe(first.handle);
    expect(library.readCalls).toEqual([firstDraftId, draftId("draft:missing")]);
  });

  it("shares one in-flight open for the same Draft and rejects a competing target", async () => {
    const { library, session } = setup();
    let releaseRead: (() => void) | undefined;
    library.readGates.set(firstDraftId, new Promise<void>((resolve) => {
      releaseRead = resolve;
    }));

    const first = session.open(firstDraftId);
    const duplicate = session.open(firstDraftId);
    const competing = await session.open(secondDraftId);
    releaseRead?.();

    expect(await duplicate).toBe(await first);
    expect(competing).toEqual({ status: "open-failed", reason: "busy" });
    expect(library.readCalls).toEqual([firstDraftId]);
  });

  it("does not let a stale handle schedule persistence after a successful switch", async () => {
    const { library, session } = setup();
    const first = await session.open(firstDraftId);
    const second = await session.open(secondDraftId);
    library.saveCalls.length = 0;
    if (first.status !== "opened" || second.status !== "opened") return;

    const before = first.handle.editing.read();
    expect(first.handle.editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#112233"),
    })).toEqual({ status: "unavailable", reason: "session-inactive" });
    await session.flush();

    expect(library.saveCalls).toEqual([]);
    expect(first.handle.editing.read()).toBe(before);
  });

  it("preserves history for idempotent open and resets it after switching away", async () => {
    const { session } = setup(10_000);
    const first = await session.open(firstDraftId);
    if (first.status !== "opened") return;
    first.handle.editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#123456"),
    });

    const same = await session.open(firstDraftId);
    expect(same.status).toBe("opened");
    if (same.status !== "opened") return;
    expect(same.handle).toBe(first.handle);
    expect(same.handle.editing.read().canUndo).toBe(true);

    const second = await session.open(secondDraftId);
    expect(second.status).toBe("opened");
    if (second.status !== "opened") return;
    expect(second.handle.editing.read().canUndo).toBe(false);

    const reopened = await session.open(firstDraftId);
    expect(reopened.status).toBe("opened");
    if (reopened.status !== "opened") return;
    expect(reopened.handle).not.toBe(first.handle);
    expect(reopened.handle.editing.read()).toMatchObject({
      canUndo: false,
      canRedo: false,
      document: { canvas: { backgroundColor: "#123456" } },
    });
  });

  it("debounces successful Edit Commits and autosaves the latest document once", async () => {
    jest.useFakeTimers();
    const { library, session } = setup(25);
    const opened = await session.open(firstDraftId);
    if (opened.status !== "opened") return;

    opened.handle.editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#111111"),
    });
    opened.handle.editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#222222"),
    });
    jest.advanceTimersByTime(25);
    await session.flush();

    expect(library.saveCalls).toHaveLength(1);
    expect(library.saveCalls[0]?.document.canvas.backgroundColor).toBe("#222222");
    jest.useRealTimers();
  });

  it("retains dirty state after a background save failure and retries on flush", async () => {
    jest.useFakeTimers();
    const { library, session } = setup(10);
    const opened = await session.open(firstDraftId);
    if (opened.status !== "opened") return;
    library.saveResult = {
      status: "save-failed",
      reason: "storage-failed",
      message: "disk full",
    };
    opened.handle.editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#123456"),
    });

    jest.advanceTimersByTime(10);
    await Promise.resolve();
    await Promise.resolve();
    library.saveResult = null;

    await expect(session.flush()).resolves.toEqual({ status: "flushed" });
    expect(library.saveCalls).toHaveLength(2);
    expect(library.saveCalls[1]?.document.canvas.backgroundColor).toBe("#123456");
    jest.useRealTimers();
  });

  it("returns a typed flush failure without discarding the latest document", async () => {
    const { library, session } = setup(10_000);
    const opened = await session.open(firstDraftId);
    if (opened.status !== "opened") return;
    library.saveResult = {
      status: "save-failed",
      reason: "storage-failed",
      message: "disk full",
    };
    opened.handle.editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#ABCDEF"),
    });

    expect(await session.flush()).toEqual({
      status: "flush-failed",
      reason: "storage-failed",
      message: "disk full",
    });
    library.saveResult = null;
    expect(await session.flush()).toEqual({ status: "flushed" });
    expect(library.saveCalls[1]?.document.canvas.backgroundColor).toBe("#ABCDEF");
  });

  it("blocks a switch when the current latest revision cannot flush", async () => {
    const { library, session } = setup(10_000);
    const first = await session.open(firstDraftId);
    if (first.status !== "opened") return;
    first.handle.editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#112233"),
    });
    library.saveResult = { status: "save-failed", reason: "storage-failed" };

    const failed = await session.open(secondDraftId);
    const reopened = await session.open(firstDraftId);

    expect(failed).toEqual({ status: "open-failed", reason: "flush-failed" });
    expect(reopened.status).toBe("opened");
    if (reopened.status !== "opened") return;
    expect(reopened.handle).toBe(first.handle);
    expect(library.readCalls).toEqual([firstDraftId]);
  });

  it("flushes edits that arrive while an older revision is being saved", async () => {
    const { library, session } = setup(10_000);
    const opened = await session.open(firstDraftId);
    if (opened.status !== "opened") return;
    let releaseFirstSave: (() => void) | undefined;
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    let saveCount = 0;
    library.saveImplementation = async (id, document) => {
      saveCount += 1;
      if (saveCount === 1) await firstSaveGate;
      const aggregate = library.aggregates.get(id)!;
      library.aggregates.set(id, { ...aggregate, document });
      return { status: "saved", ...draftVersionFacts, document };
    };
    opened.handle.editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#111111"),
    });

    const flushing = session.flush();
    await Promise.resolve();
    opened.handle.editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#222222"),
    });
    releaseFirstSave?.();

    expect(await flushing).toEqual({ status: "flushed" });
    expect(library.saveCalls).toHaveLength(2);
    expect(library.saveCalls[1]?.document.canvas.backgroundColor).toBe("#222222");
  });

  it("flushes edits that arrive during target validation before completing a switch", async () => {
    const { library, session } = setup(10_000);
    const first = await session.open(firstDraftId);
    if (first.status !== "opened") return;
    first.handle.editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#111111"),
    });
    let releaseTargetRead: (() => void) | undefined;
    library.readGates.set(secondDraftId, new Promise<void>((resolve) => {
      releaseTargetRead = resolve;
    }));

    const switching = session.open(secondDraftId);
    for (let step = 0; step < 5 && !library.readCalls.includes(secondDraftId); step += 1) {
      await Promise.resolve();
    }
    first.handle.editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#222222"),
    });
    releaseTargetRead?.();

    expect((await switching).status).toBe("opened");
    expect(library.saveCalls).toHaveLength(2);
    expect(library.aggregates.get(firstDraftId)?.document.canvas.backgroundColor).toBe(
      "#222222",
    );
  });

  it("blocks asset publication while a target Draft is being validated", async () => {
    const { library, session } = setup(10_000);
    const first = await session.open(firstDraftId);
    if (first.status !== "opened") return;
    let releaseTargetRead: (() => void) | undefined;
    library.readGates.set(secondDraftId, new Promise<void>((resolve) => {
      releaseTargetRead = resolve;
    }));
    const ingest = jest.spyOn(library, "ingest");

    const switching = session.open(secondDraftId);
    for (let step = 0; step < 5 && !library.readCalls.includes(secondDraftId); step += 1) {
      await Promise.resolve();
    }
    await expect(
      first.handle.addImages([candidate("picker://during-switch.jpg")]),
    ).resolves.toEqual({
      status: "busy",
      imported: [],
      errors: [],
      commit: null,
    });
    await expect(session.flush()).resolves.toEqual({
      status: "flush-failed",
      reason: "busy",
    });
    releaseTargetRead?.();

    await expect(switching).resolves.toMatchObject({ status: "opened" });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("rebuilds previews through the handle while preserving stable asset access identity", async () => {
    const { library, session } = setup();
    const opened = await session.open(firstDraftId);
    if (opened.status !== "opened") return;
    const stableAssets = opened.handle.assets;
    const rebuiltAssets = createAssets(firstDraftId, [firstImageId]);
    library.previewResult = {
      status: "ready",
      descriptor: Object.freeze({
        draftId: firstDraftId,
        assetId: firstImageId,
        usage: "preview",
        uri: "memory://rebuilt-preview",
      }),
      assets: Object.freeze({
        entries: rebuiltAssets.entries,
        resolve: (assetId: ImportedAssetId, usage: AssetUsage) =>
          assetId === firstImageId
            ? Object.freeze({
                draftId: firstDraftId,
                assetId,
                usage,
                uri: `memory://rebuilt/${usage}`,
              })
            : null,
      }),
    };

    const prepared = await opened.handle.preparePreviews();

    expect(prepared).toEqual({ status: "prepared" });
    expect(opened.handle.assets).toBe(stableAssets);
    expect(stableAssets.resolve(firstImageId, "preview")?.uri).toBe(
      "memory://rebuilt/preview",
    );
  });

  it("reports preview failure without invalidating the open session", async () => {
    const { library, session } = setup();
    const opened = await session.open(firstDraftId);
    if (opened.status !== "opened") return;
    library.previewResult = {
      status: "preview-failed",
      reason: "preview-unavailable",
      message: "decode failed",
    };

    expect(await opened.handle.preparePreviews()).toEqual({
      status: "preview-failed",
      reason: "preview-unavailable",
      message: "decode failed",
    });
    const reopened = await session.open(firstDraftId);
    expect(reopened.status).toBe("opened");
    if (reopened.status !== "opened") return;
    expect(reopened.handle).toBe(opened.handle);
  });

  it("publishes a successful add batch before one Edit Commit and undoes it in one step", async () => {
    const { library, session } = setup(10_000);
    const opened = await session.open(firstDraftId);
    if (opened.status !== "opened") return;
    const addedImageId = importedAssetId("asset:added");
    const publishedAssets = createAssets(firstDraftId, [firstImageId, addedImageId]);
    library.ingestImplementation = async () => ({
      status: "ingested",
      imported: [
        {
          image: { id: addedImageId, width: 800, height: 600 },
          sourceKind: "image",
        },
      ],
      errors: [
        { index: 1, sourceUri: "picker://broken.jpg", message: "decode failed" },
      ],
      assets: publishedAssets,
    });
    let resolvedAtCommit = false;
    const unsubscribe = opened.handle.editing.subscribe(() => {
      resolvedAtCommit =
        opened.handle.assets.resolve(addedImageId, "preview")?.assetId === addedImageId;
    });

    const result = await opened.handle.addImages([
      candidate("picker://added.jpg"),
      candidate("picker://broken.jpg"),
    ]);
    unsubscribe();

    expect(result).toMatchObject({
      status: "completed",
      imported: [{ image: { id: addedImageId } }],
      errors: [{ index: 1, sourceUri: "picker://broken.jpg" }],
      commit: { status: "changed", revision: 1 },
    });
    expect(resolvedAtCommit).toBe(true);
    expect(opened.handle.editing.read().document.sourceImages.map(({ id }) => id)).toEqual([
      firstImageId,
      addedImageId,
    ]);
    await session.flush();
    expect(library.saveCalls).toHaveLength(1);
    expect(opened.handle.editing.dispatch({ type: "undo" }).status).toBe("changed");
    expect(opened.handle.editing.read().document.sourceImages.map(({ id }) => id)).toEqual([
      firstImageId,
    ]);
    await session.flush();
    expect(library.saveCalls).toHaveLength(2);
  });

  it("reports overflow before ingest and commits the successful capacity-limited batch", async () => {
    const { library, session } = setup(10_000);
    const existingImages = Array.from({ length: 8 }, (_, index) => ({
      id: importedAssetId(`asset:${index}`),
      width: 100,
      height: 100,
    }));
    library.aggregates.set(firstDraftId, {
      document: createDocument(existingImages),
      assets: createAssets(
        firstDraftId,
        existingImages.map(({ id }) => id),
      ),
    });
    const ingestedCandidates: ImportCandidate[][] = [];
    const finalImageId = importedAssetId("asset:final");
    library.ingestImplementation = async (_id, candidates) => {
      ingestedCandidates.push([...candidates]);
      return {
        status: "ingested",
        imported: [
          { image: { id: finalImageId, width: 800, height: 600 }, sourceKind: "image" },
        ],
        errors: [],
        assets: createAssets(firstDraftId, [
          ...existingImages.map(({ id }) => id),
          finalImageId,
        ]),
      };
    };
    const opened = await session.open(firstDraftId);
    if (opened.status !== "opened") return;

    const result = await opened.handle.addImages([
      candidate("picker://fits.jpg"),
      candidate("picker://overflow-1.jpg"),
      candidate("picker://overflow-2.jpg"),
    ]);

    expect(ingestedCandidates).toEqual([[candidate("picker://fits.jpg")]]);
    expect(result).toMatchObject({
      status: "completed",
      errors: [
        { index: 1, sourceUri: "picker://overflow-1.jpg" },
        { index: 2, sourceUri: "picker://overflow-2.jpg" },
      ],
      commit: { status: "changed", revision: 1 },
    });
    expect(opened.handle.editing.read().document.sourceImages).toHaveLength(9);
    await session.flush();
    expect(library.saveCalls).toHaveLength(1);
  });

  it("does not ingest or commit an add batch when the Draft is already at capacity", async () => {
    const { library, session } = setup(10_000);
    const existingImages = Array.from({ length: 9 }, (_, index) => ({
      id: importedAssetId(`asset:${index}`),
      width: 100,
      height: 100,
    }));
    library.aggregates.set(firstDraftId, {
      document: createDocument(existingImages),
      assets: createAssets(
        firstDraftId,
        existingImages.map(({ id }) => id),
      ),
    });
    const ingest = jest.spyOn(library, "ingest");
    const opened = await session.open(firstDraftId);
    if (opened.status !== "opened") return;

    const result = await opened.handle.addImages([candidate("picker://overflow.jpg")]);

    expect(ingest).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "completed",
      imported: [],
      errors: [{ index: 0, sourceUri: "picker://overflow.jpg" }],
      commit: null,
    });
    expect(opened.handle.editing.read()).toMatchObject({ revision: 0, canUndo: false });
  });

  it("keeps published assets when an add Edit Commit is rejected", async () => {
    const { library, session } = setup(10_000);
    const opened = await session.open(firstDraftId);
    if (opened.status !== "opened") return;
    library.ingestImplementation = async () => ({
      status: "ingested",
      imported: [
        {
          image: { id: firstImageId, width: 1200, height: 800 },
          sourceKind: "image",
        },
      ],
      errors: [],
      assets: createAssets(firstDraftId, [firstImageId]),
    });

    const result = await opened.handle.addImages([candidate("picker://duplicate.jpg")]);

    expect(result).toMatchObject({
      status: "completed",
      commit: { status: "rejected", code: "duplicate-entity" },
    });
    expect(opened.handle.assets.resolve(firstImageId, "original")).not.toBeNull();
    expect(opened.handle.editing.read()).toMatchObject({ revision: 0, canUndo: false });
    await session.flush();
    expect(library.saveCalls).toEqual([]);
  });

  it("preserves the current asset snapshot when publication fails", async () => {
    const { library, session } = setup(10_000);
    const opened = await session.open(firstDraftId);
    if (opened.status !== "opened") return;
    const originalUri = opened.handle.assets.resolve(firstImageId, "original")?.uri;
    library.ingestImplementation = async () => ({
      status: "ingest-failed",
      imported: [],
      errors: [{ index: 0, sourceUri: "picker://broken.jpg", message: "copy failed" }],
      message: "storage unavailable",
    });

    await expect(
      opened.handle.addImages([candidate("picker://broken.jpg")]),
    ).resolves.toMatchObject({
      status: "publish-failed",
      imported: [],
      commit: null,
      message: "storage unavailable",
    });
    expect(opened.handle.assets.resolve(firstImageId, "original")?.uri).toBe(originalUri);
    expect(opened.handle.editing.read()).toMatchObject({ revision: 0, canUndo: false });
    await session.flush();
    expect(library.saveCalls).toEqual([]);
  });

  it("rejects overlapping asset operations without publishing or committing twice", async () => {
    const { library, session } = setup(10_000);
    const opened = await session.open(firstDraftId);
    if (opened.status !== "opened") return;
    let releaseIngest: (() => void) | undefined;
    let markIngestStarted: (() => void) | undefined;
    const ingestStarted = new Promise<void>((resolve) => {
      markIngestStarted = resolve;
    });
    const ingestGate = new Promise<void>((resolve) => {
      releaseIngest = resolve;
    });
    library.ingestImplementation = async () => {
      markIngestStarted?.();
      await ingestGate;
      return {
        status: "ingested",
        imported: [],
        errors: [],
        assets: createAssets(firstDraftId, [firstImageId]),
      };
    };

    const adding = opened.handle.addImages([candidate("picker://pending.jpg")]);
    await ingestStarted;
    await expect(
      opened.handle.replaceImage(firstImageId, candidate("picker://replacement.jpg")),
    ).resolves.toEqual({
      status: "busy",
      imported: [],
      errors: [],
      commit: null,
    });
    await expect(session.flush()).resolves.toEqual({
      status: "flush-failed",
      reason: "busy",
    });
    releaseIngest?.();
    await adding;
    await expect(session.flush()).resolves.toEqual({ status: "flushed" });
    expect(library.saveCalls).toEqual([]);
  });

  it("rejects asset mutations from a stale handle after a successful switch", async () => {
    const { library, session } = setup(10_000);
    const first = await session.open(firstDraftId);
    const second = await session.open(secondDraftId);
    if (first.status !== "opened" || second.status !== "opened") return;
    const ingest = jest.spyOn(library, "ingest");

    await expect(
      first.handle.addImages([candidate("picker://stale.jpg")]),
    ).resolves.toEqual({
      status: "session-inactive",
      imported: [],
      errors: [],
      commit: null,
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("replaces one image in place and undo restores the original asset", async () => {
    const { library, session } = setup(10_000);
    const opened = await session.open(firstDraftId);
    if (opened.status !== "opened") return;
    const replacementId = importedAssetId("asset:replacement");
    library.ingestImplementation = async () => ({
      status: "ingested",
      imported: [
        {
          image: { id: replacementId, width: 640, height: 960 },
          sourceKind: "image",
        },
      ],
      errors: [],
      assets: createAssets(firstDraftId, [firstImageId, replacementId]),
    });

    const result = await opened.handle.replaceImage(
      firstImageId,
      candidate("picker://replacement.jpg"),
    );

    expect(result).toMatchObject({
      status: "completed",
      commit: { status: "changed", revision: 1 },
    });
    expect(opened.handle.editing.read().document.sourceImages[0]?.id).toBe(replacementId);
    expect(opened.handle.editing.read().document.stitch.order).toEqual([replacementId]);
    await session.flush();
    expect(library.saveCalls).toHaveLength(1);
    expect(opened.handle.editing.dispatch({ type: "undo" }).status).toBe("changed");
    expect(opened.handle.editing.read().document.sourceImages[0]?.id).toBe(firstImageId);
    expect(opened.handle.assets.resolve(firstImageId, "preview")).not.toBeNull();
    await session.flush();
    expect(library.saveCalls).toHaveLength(2);
  });

  it("does not commit a replace when its candidate fails to publish", async () => {
    const { library, session } = setup(10_000);
    const opened = await session.open(firstDraftId);
    if (opened.status !== "opened") return;
    library.ingestImplementation = async () => ({
      status: "ingested",
      imported: [],
      errors: [{ index: 0, sourceUri: "picker://broken.jpg", message: "decode failed" }],
      assets: createAssets(firstDraftId, [firstImageId]),
    });

    const result = await opened.handle.replaceImage(
      firstImageId,
      candidate("picker://broken.jpg"),
    );

    expect(result).toMatchObject({ status: "completed", imported: [], commit: null });
    expect(opened.handle.editing.read()).toMatchObject({ revision: 0, canUndo: false });
    expect(opened.handle.editing.read().document.sourceImages[0]?.id).toBe(firstImageId);
  });
});
