import {
  createDocument,
  importedAssetId,
  type ImportedAssetId,
} from "@/core/document";
import { editIntents } from "@/core/editing";
import {
  draftId,
  type AssetCatalogSnapshot,
  type CreateDraftResult,
  type DraftLibrary,
  type DraftLibraryState,
  type ImportCandidate,
} from "@/services/drafts/draftLibrary";
import { createCurrentEditingSession } from "@/services/session/currentEditingSession";

import { EditorRuntime } from "../runtime";

const firstId = draftId("draft:1");
const secondId = draftId("draft:2");
const firstImageId = importedAssetId("image:1");
const secondImageId = importedAssetId("image:2");
const versionFacts = {
  metadata: {
    createdAt: "2026-07-22T08:00:00.000Z",
    updatedAt: "2026-07-22T08:00:00.000Z",
  },
  contentRevision: 1,
} as const;

function snapshot(
  uri: string,
  id = firstId,
  imageId = firstImageId,
): AssetCatalogSnapshot {
  return Object.freeze({
    entries: Object.freeze([imageId]),
    resolve: (candidate: ImportedAssetId, usage: "preview" | "original" | "metadata") =>
      candidate === imageId
        ? { draftId: id, assetId: candidate, usage, uri: `${uri}/${usage}` }
        : null,
  });
}

const firstDocument = createDocument([{ id: firstImageId, width: 1200, height: 900 }]);
const secondDocument = createDocument([{ id: secondImageId, width: 900, height: 1200 }]);
const pickerCandidate: ImportCandidate = {
  uri: "picker://two.jpg",
  width: 900,
  height: 1200,
  kind: "image",
};

function createLibrary(overrides: Partial<DraftLibrary> = {}): DraftLibrary {
  let state: DraftLibraryState = { status: "ready", entries: [] };
  return {
    load: jest.fn(async () => state),
    getState: () => state,
    subscribe: jest.fn(() => () => undefined),
    create: jest.fn(),
    read: jest.fn(async (id) =>
      id === firstId
        ? {
            status: "ready" as const,
            draftId: firstId,
            document: firstDocument,
            assets: snapshot("memory://first"),
            ...versionFacts,
          }
        : {
            status: "ready" as const,
            draftId: secondId,
            document: secondDocument,
            assets: snapshot("memory://second", secondId, secondImageId),
            ...versionFacts,
          },
    ),
    save: jest.fn(async (_id, document) => ({
      status: "saved" as const,
      document,
      ...versionFacts,
    })),
    deleteDraft: jest.fn(async () => ({ status: "deleted" as const })),
    ingest: jest.fn(),
    readPreview: jest.fn(async (id, imageId) => {
      const assets =
        id === firstId
          ? snapshot("memory://first")
          : snapshot("memory://second", secondId, secondImageId);
      return {
        status: "ready" as const,
        descriptor: assets.resolve(imageId, "preview")!,
        assets,
      };
    }),
    reportThumbnailLoadFailure: jest.fn(),
    maintainInactive: jest.fn(async () => undefined),
    ...overrides,
  };
}

function createRuntime(library: DraftLibrary, candidates: readonly ImportCandidate[] = []) {
  return new EditorRuntime({
    storage: { library },
    session: createCurrentEditingSession({ library, autosaveDelayMs: 10_000 }),
    selectCandidates: async () => candidates,
    loadMetadataPolicy: async () => "strip",
  });
}

describe("editor Draft integration", () => {
  it("[F08-S13] exposes Draft Library state without loading or merging it in Home", async () => {
    const library = createLibrary();
    const runtime = createRuntime(library);
    const listener = jest.fn();

    const unsubscribe = runtime.subscribeDraftLibrary(listener);
    await expect(runtime.loadDraftLibrary()).resolves.toEqual({ status: "ready", entries: [] });
    expect(runtime.getDraftLibraryState()).toEqual({ status: "ready", entries: [] });
    expect(library.subscribe).toHaveBeenCalledWith(listener);
    unsubscribe();
  });

  it("does not infer a recent Draft when no Grid item has been opened", async () => {
    const runtime = createRuntime(createLibrary());

    await expect(runtime.prepareEditor()).resolves.toEqual({ status: "no-draft" });
  });

  it("[F06-S02] opens the exact selected Draft and prepares its previews", async () => {
    const library = createLibrary();
    const runtime = createRuntime(library);

    await expect(runtime.openDraft(secondId)).resolves.toEqual({
      status: "opened",
      draftId: secondId,
      contentRevision: 1,
    });
    await expect(runtime.prepareEditor()).resolves.toMatchObject({ status: "prepared" });
    expect(library.read).toHaveBeenCalledWith(secondId);
    expect(library.read).not.toHaveBeenCalledWith(firstId);
    expect(library.readPreview).toHaveBeenCalledWith(secondId, secondImageId);
  });

  it("[F06-S07][F08-S19] reuses the same-process session and undo history for the same Draft", async () => {
    const library = createLibrary();
    const runtime = createRuntime(library);
    await runtime.openDraft(firstId);
    const first = await runtime.prepareEditor();
    if (first.status !== "prepared") throw new Error("expected prepared editor");
    first.editing.dispatch({
      type: "commit",
      intent: { type: "canvas.change-background", color: "#123456" },
    });

    await runtime.openDraft(firstId);
    const reopened = await runtime.prepareEditor();

    expect(library.read).toHaveBeenCalledTimes(1);
    expect(reopened).toMatchObject({
      status: "prepared",
      editing: { read: expect.any(Function) },
    });
    if (reopened.status !== "prepared") throw new Error("expected prepared editor");
    expect(reopened.editing.read().canUndo).toBe(true);
    await runtime.flush();
  });

  it("[F06-S05][F08-S20] keeps the current session when switching to another Draft fails", async () => {
    const library = createLibrary({
      read: jest.fn(async (id) =>
        id === secondId
          ? ({ status: "recovery-failed", reason: "document-corrupt" } as const)
          : ({
              status: "ready" as const,
              draftId: firstId,
              document: firstDocument,
              assets: snapshot("memory://first"),
              ...versionFacts,
            } as const),
      ),
    });
    const runtime = createRuntime(library);
    await runtime.openDraft(firstId);

    await expect(runtime.openDraft(secondId)).resolves.toEqual({
      status: "open-failed",
      reason: "document-corrupt",
    });
    await expect(runtime.prepareEditor()).resolves.toMatchObject({
      status: "prepared",
      editing: { read: expect.any(Function) },
    });
  });

  it("flushes the current Draft before creating and opening a new one", async () => {
    const events: string[] = [];
    const created: Extract<CreateDraftResult, { status: "created" }> = {
      status: "created",
      draftId: secondId,
      document: secondDocument,
      assets: snapshot("memory://second", secondId, secondImageId),
      errors: [],
      ...versionFacts,
    };
    const library = createLibrary({
      create: jest.fn(async () => {
        events.push("create");
        return created;
      }),
      save: jest.fn(async (_id, document) => {
        events.push("save-current");
        return { status: "saved" as const, document, ...versionFacts };
      }),
      read: jest.fn(async (id) => {
        events.push(id === firstId ? "open-first" : "open-second");
        return id === firstId
          ? {
              status: "ready" as const,
              draftId: firstId,
              document: firstDocument,
              assets: snapshot("memory://first"),
              ...versionFacts,
            }
          : {
              status: "ready" as const,
              draftId: secondId,
              document: secondDocument,
              assets: created.assets,
              ...versionFacts,
            };
      }),
    });
    const runtime = createRuntime(library, [pickerCandidate]);
    await runtime.openDraft(firstId);
    const prepared = await runtime.prepareEditor();
    if (prepared.status !== "prepared") throw new Error("expected prepared editor");
    prepared.editing.dispatch({
      type: "commit",
      intent: { type: "canvas.change-background", color: "#112233" },
    });

    await expect(runtime.choosePhotos()).resolves.toMatchObject({ status: "created" });

    expect(events).toEqual(["open-first", "save-current", "create", "open-second"]);
    await expect(runtime.prepareEditor()).resolves.toMatchObject({ status: "prepared" });
  });

  it("[F04-S07] keeps a Draft photo-information override separate from the global default for new Drafts", async () => {
    const created: Extract<CreateDraftResult, { status: "created" }> = {
      status: "created",
      draftId: secondId,
      document: secondDocument,
      assets: snapshot("memory://second", secondId, secondImageId),
      errors: [],
      ...versionFacts,
    };
    const library = createLibrary({
      create: jest.fn(async (_candidates, options) => {
        expect(options).toEqual({ metadataPolicy: "strip" });
        return created;
      }),
    });
    const loadMetadataPolicy = jest.fn(async () => "strip" as const);
    const runtime = new EditorRuntime({
      storage: { library },
      session: createCurrentEditingSession({ library, autosaveDelayMs: 10_000 }),
      selectCandidates: async () => [pickerCandidate],
      loadMetadataPolicy,
    });
    await runtime.openDraft(firstId);
    const prepared = await runtime.prepareEditor();
    if (prepared.status !== "prepared") throw new Error("expected prepared editor");

    prepared.editing.dispatch({
      type: "commit",
      intent: editIntents.export.changeMetadataPolicy("retain-basic"),
    });
    await expect(runtime.flush()).resolves.toEqual({ status: "flushed" });
    await expect(runtime.choosePhotos()).resolves.toMatchObject({ status: "created" });

    expect(library.save).toHaveBeenCalledWith(
      firstId,
      expect.objectContaining({
        exportSettings: expect.objectContaining({ metadataPolicy: "retain-basic" }),
      }),
    );
    expect(loadMetadataPolicy).toHaveBeenCalledTimes(1);
  });

  it("[F07-S05] returns picker cancellation before loading settings or creating a Draft", async () => {
    const library = createLibrary();
    const loadMetadataPolicy = jest.fn(async () => "strip" as const);
    const runtime = new EditorRuntime({
      storage: { library },
      session: createCurrentEditingSession({ library }),
      selectCandidates: async () => [],
      loadMetadataPolicy,
    });

    await expect(runtime.choosePhotos()).resolves.toEqual({
      status: "not-created",
      errors: [],
    });
    expect(loadMetadataPolicy).not.toHaveBeenCalled();
    expect(library.create).not.toHaveBeenCalled();
  });

  it("opens a partially imported Draft and exposes its failed-item count once", async () => {
    const successfulIds = [
      importedAssetId("image:partial-first"),
      importedAssetId("image:partial-second"),
    ] as const;
    const partialDocument = createDocument([
      { id: successfulIds[0], width: 1200, height: 900 },
      { id: successfulIds[1], width: 900, height: 1200 },
    ]);
    const partialAssets: AssetCatalogSnapshot = Object.freeze({
      entries: Object.freeze([...successfulIds]),
      resolve: (imageId: ImportedAssetId, usage: "preview" | "original" | "metadata") =>
        successfulIds.includes(imageId as (typeof successfulIds)[number])
          ? Object.freeze({
              draftId: secondId,
              assetId: imageId,
              usage,
              uri: `memory://partial/${imageId}/${usage}`,
            })
          : null,
    });
    const created: Extract<CreateDraftResult, { status: "created" }> = {
      status: "created",
      draftId: secondId,
      document: partialDocument,
      assets: partialAssets,
      errors: [
        {
          index: 1,
          sourceUri: "picker://icloud-failed.jpg",
          message: "iCloud download failed",
        },
      ],
      ...versionFacts,
    };
    const library = createLibrary({
      create: jest.fn(async () => created),
      read: jest.fn(async () => ({
        status: "ready" as const,
        draftId: secondId,
        document: partialDocument,
        assets: partialAssets,
        ...versionFacts,
      })),
      readPreview: jest.fn(async (_id, imageId) => ({
        status: "ready" as const,
        descriptor: partialAssets.resolve(imageId, "preview")!,
        assets: partialAssets,
      })),
    });
    const candidates: readonly ImportCandidate[] = [
      pickerCandidate,
      { ...pickerCandidate, uri: "picker://icloud-failed.jpg" },
      { ...pickerCandidate, uri: "picker://third.jpg" },
    ];
    const runtime = createRuntime(library, candidates);

    await expect(runtime.choosePhotos()).resolves.toEqual(created);
    expect(runtime.takeImportErrorCount()).toBe(1);
    expect(runtime.takeImportErrorCount()).toBe(0);

    const prepared = await runtime.prepareEditor();
    if (prepared.status !== "prepared") throw new Error("expected prepared editor");
    expect(prepared.editing.read().document.sourceImages.map(({ id }) => id)).toEqual(
      successfulIds,
    );
  });

  it("deletes only through the current-session coordinator", async () => {
    const library = createLibrary();
    const runtime = createRuntime(library);
    await runtime.openDraft(firstId);

    await expect(runtime.deleteDraft(firstId)).resolves.toEqual({ status: "deleted" });
    await expect(runtime.prepareEditor()).resolves.toEqual({ status: "no-draft" });
    expect(library.deleteDraft).toHaveBeenCalledWith(firstId);
  });
});
