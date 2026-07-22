import {
  createDocument,
  importedAssetId,
  type ImportedAssetId,
} from "@/core/document";
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
  it("exposes Draft Library state without loading or merging it in Home", async () => {
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

  it("opens the exact selected Draft and prepares its previews", async () => {
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

  it("reuses the same-process session and undo history for the same Draft", async () => {
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

  it("keeps the current session when switching to another Draft fails", async () => {
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

  it("returns picker cancellation before loading settings or creating a Draft", async () => {
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

  it("deletes only through the current-session coordinator", async () => {
    const library = createLibrary();
    const runtime = createRuntime(library);
    await runtime.openDraft(firstId);

    await expect(runtime.deleteDraft(firstId)).resolves.toEqual({ status: "deleted" });
    await expect(runtime.prepareEditor()).resolves.toEqual({ status: "no-draft" });
    expect(library.deleteDraft).toHaveBeenCalledWith(firstId);
  });
});
