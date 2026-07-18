import { createDocument, importedAssetId } from "@/core/document";
import {
  draftId,
  type AssetCatalogSnapshot,
  type CreateDraftResult,
  type DraftLibrary,
  type ImportCandidate,
} from "@/services/drafts/draftLibrary";
import { createCurrentEditingSession } from "@/services/session/currentEditingSession";

import { EditorRuntime } from "../runtime";

const testDraftId = draftId("draft:1");
const nextDraftId = draftId("draft:2");
const testImageId = importedAssetId("image:1");
const nextImageId = importedAssetId("image:2");

function snapshot(
  uri: string,
  id = testDraftId,
  imageId = testImageId,
): AssetCatalogSnapshot {
  return Object.freeze({
    entries: Object.freeze([imageId]),
    resolve: (
      assetId: Parameters<AssetCatalogSnapshot["resolve"]>[0],
      usage: Parameters<AssetCatalogSnapshot["resolve"]>[1],
    ) =>
      assetId === imageId
        ? { draftId: id, assetId, usage, uri: `${uri}/${usage}` }
        : null,
  });
}

const pickerCandidate: ImportCandidate = {
  uri: "picker://two.jpg",
  width: 600,
  height: 800,
  kind: "image",
};

function createdDraft(): Extract<CreateDraftResult, { readonly status: "created" }> {
  return {
    status: "created",
    draftId: nextDraftId,
    document: createDocument([{ id: nextImageId, width: 600, height: 800 }]),
    assets: snapshot("memory://next", nextDraftId, nextImageId),
    errors: [],
  };
}

describe("editor Draft integration", () => {
  it("rebuilds a missing preview through Draft Library before exposing the editor", async () => {
    const document = createDocument([{ id: testImageId, width: 4000, height: 3000 }]);
    const initialAssets = snapshot("memory://before");
    const rebuiltAssets = snapshot("memory://after");
    const library: DraftLibrary = {
      create: jest.fn(),
      ingest: jest.fn(),
      save: jest.fn(async (_id, next) => ({ status: "saved" as const, document: next })),
      read: jest.fn(async () => ({
        status: "ready" as const,
        draftId: testDraftId,
        document,
        assets: initialAssets,
      })),
      readPreview: jest.fn(async () => ({
        status: "ready" as const,
        descriptor: rebuiltAssets.resolve(testImageId, "preview")!,
        assets: rebuiltAssets,
      })),
    };
    const runtime = new EditorRuntime({
      storage: {
        library,
        readRecentDraftId: async () => testDraftId,
        writeRecentDraftId: async () => undefined,
      },
      session: createCurrentEditingSession({ library, autosaveDelayMs: 10_000 }),
      selectCandidates: async () => [],
      loadMetadataPolicy: async () => "strip",
    });

    const prepared = await runtime.prepareEditor();

    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    expect(library.readPreview).toHaveBeenCalledWith(testDraftId, testImageId);
    expect(prepared.assets).not.toBe(initialAssets);
    expect(prepared.assets).not.toBe(rebuiltAssets);
    expect(prepared.assets.resolve(testImageId, "preview")?.uri).toBe(
      "memory://after/preview",
    );
  });

  it("shares concurrent editor preparation and starts a new run after it settles", async () => {
    const document = createDocument([{ id: testImageId, width: 4000, height: 3000 }]);
    const assets = snapshot("memory://prepared");
    let markPreviewStarted: (() => void) | undefined;
    let releasePreview: (() => void) | undefined;
    const previewStarted = new Promise<void>((resolve) => {
      markPreviewStarted = resolve;
    });
    const previewGate = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    const readPreview = jest.fn(async () => {
      markPreviewStarted?.();
      await previewGate;
      return {
        status: "ready" as const,
        descriptor: assets.resolve(testImageId, "preview")!,
        assets,
      };
    });
    const library: DraftLibrary = {
      create: jest.fn(),
      ingest: jest.fn(),
      save: jest.fn(async (_id, next) => ({ status: "saved" as const, document: next })),
      read: jest.fn(async () => ({
        status: "ready" as const,
        draftId: testDraftId,
        document,
        assets,
      })),
      readPreview,
    };
    const runtime = new EditorRuntime({
      storage: {
        library,
        readRecentDraftId: async () => testDraftId,
        writeRecentDraftId: async () => undefined,
      },
      session: createCurrentEditingSession({ library, autosaveDelayMs: 10_000 }),
      selectCandidates: async () => [],
      loadMetadataPolicy: async () => "strip",
    });

    const first = runtime.prepareEditor();
    await previewStarted;
    const second = runtime.prepareEditor();
    expect(second).toBe(first);
    releasePreview?.();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.status).toBe("prepared");
    expect(secondResult.status).toBe("prepared");
    expect(readPreview).toHaveBeenCalledTimes(1);

    const next = runtime.prepareEditor();
    expect(next).not.toBe(first);
    await expect(next).resolves.toMatchObject({ status: "prepared" });
    expect(readPreview).toHaveBeenCalledTimes(2);
  });

  it("returns a typed preview failure while preserving the active session for retry", async () => {
    const document = createDocument([{ id: testImageId, width: 4000, height: 3000 }]);
    const initialAssets = snapshot("memory://before");
    const rebuiltAssets = snapshot("memory://after");
    const readPreview = jest
      .fn<ReturnType<DraftLibrary["readPreview"]>, Parameters<DraftLibrary["readPreview"]>>()
      .mockResolvedValueOnce({
        status: "preview-failed",
        reason: "preview-unavailable",
        message: "decode failed",
      })
      .mockResolvedValue({
        status: "ready",
        descriptor: rebuiltAssets.resolve(testImageId, "preview")!,
        assets: rebuiltAssets,
      });
    const library: DraftLibrary = {
      create: jest.fn(),
      ingest: jest.fn(),
      save: jest.fn(async (_id, next) => ({ status: "saved" as const, document: next })),
      read: jest.fn(async () => ({
        status: "ready" as const,
        draftId: testDraftId,
        document,
        assets: initialAssets,
      })),
      readPreview,
    };
    const runtime = new EditorRuntime({
      storage: {
        library,
        readRecentDraftId: async () => testDraftId,
        writeRecentDraftId: async () => undefined,
      },
      session: createCurrentEditingSession({ library, autosaveDelayMs: 10_000 }),
      selectCandidates: async () => [],
      loadMetadataPolicy: async () => "strip",
    });

    await expect(runtime.prepareEditor()).resolves.toEqual({
      status: "preview-failed",
      reason: "preview-unavailable",
      message: "decode failed",
    });
    await expect(runtime.restore()).resolves.toMatchObject({
      status: "restored",
      draftId: testDraftId,
      document,
    });
    await expect(runtime.prepareEditor()).resolves.toMatchObject({ status: "prepared" });
    expect(library.read).toHaveBeenCalledTimes(1);
  });

  it("returns no-draft when there is no recent Draft to prepare", async () => {
    const library: DraftLibrary = {
      create: jest.fn(),
      ingest: jest.fn(),
      save: jest.fn(),
      read: jest.fn(),
      readPreview: jest.fn(),
    };
    const runtime = new EditorRuntime({
      storage: {
        library,
        readRecentDraftId: async () => null,
        writeRecentDraftId: async () => undefined,
      },
      session: createCurrentEditingSession({ library }),
      selectCandidates: async () => [],
      loadMetadataPolicy: async () => "strip",
    });

    await expect(runtime.prepareEditor()).resolves.toEqual({ status: "no-draft" });
  });

  it("passes the explicit global metadata default into Draft creation", async () => {
    const create = jest.fn<Promise<CreateDraftResult>, Parameters<DraftLibrary["create"]>>(
      async () => ({ status: "not-created", errors: [] }),
    );
    const library: DraftLibrary = {
      create,
      ingest: jest.fn(),
      save: jest.fn(),
      read: jest.fn(),
      readPreview: jest.fn(),
    };
    const runtime = new EditorRuntime({
      storage: {
        library,
        readRecentDraftId: async () => null,
        writeRecentDraftId: async () => undefined,
      },
      session: createCurrentEditingSession({ library }),
      selectCandidates: async () => [pickerCandidate],
      loadMetadataPolicy: async () => "retain-basic",
    });

    await runtime.choosePhotos();

    expect(create).toHaveBeenCalledWith([pickerCandidate], {
      metadataPolicy: "retain-basic",
    });
  });

  it("returns picker cancellation without loading settings or creating a Draft", async () => {
    const library: DraftLibrary = {
      create: jest.fn(),
      ingest: jest.fn(),
      save: jest.fn(),
      read: jest.fn(),
      readPreview: jest.fn(),
    };
    const loadMetadataPolicy = jest.fn(async () => "strip" as const);
    const runtime = new EditorRuntime({
      storage: {
        library,
        readRecentDraftId: async () => null,
        writeRecentDraftId: async () => undefined,
      },
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

  it("publishes a created Draft locator before switching the current session", async () => {
    const created = createdDraft();
    const calls: string[] = [];
    const library: DraftLibrary = {
      create: jest.fn(async () => created),
      ingest: jest.fn(),
      save: jest.fn(),
      read: jest.fn(async () => {
        calls.push("open");
        return {
          status: "ready" as const,
          draftId: created.draftId,
          document: created.document,
          assets: created.assets,
        };
      }),
      readPreview: jest.fn(async () => ({
        status: "ready" as const,
        descriptor: created.assets.resolve(nextImageId, "preview")!,
        assets: created.assets,
      })),
    };
    const runtime = new EditorRuntime({
      storage: {
        library,
        readRecentDraftId: async () => null,
        writeRecentDraftId: async () => {
          calls.push("locator");
        },
      },
      session: createCurrentEditingSession({ library, autosaveDelayMs: 10_000 }),
      selectCandidates: async () => [pickerCandidate],
      loadMetadataPolicy: async () => "strip",
    });

    await expect(runtime.choosePhotos()).resolves.toMatchObject({ status: "created" });
    expect(calls).toEqual(["locator", "open"]);
    await expect(runtime.prepareEditor()).resolves.toMatchObject({
      status: "prepared",
      editing: expect.any(Object),
    });
  });

  it("forwards typed flush failures without discarding the open session", async () => {
    const document = createDocument([{ id: testImageId, width: 100, height: 100 }]);
    const library: DraftLibrary = {
      create: jest.fn(),
      ingest: jest.fn(),
      save: jest.fn(async () => ({
        status: "save-failed" as const,
        reason: "storage-failed" as const,
        message: "disk full",
      })),
      read: jest.fn(async () => ({
        status: "ready" as const,
        draftId: testDraftId,
        document,
        assets: snapshot("memory://open"),
      })),
      readPreview: jest.fn(async () => ({
        status: "ready" as const,
        descriptor: snapshot("memory://open").resolve(testImageId, "preview")!,
        assets: snapshot("memory://open"),
      })),
    };
    const runtime = new EditorRuntime({
      storage: {
        library,
        readRecentDraftId: async () => testDraftId,
        writeRecentDraftId: async () => undefined,
      },
      session: createCurrentEditingSession({ library, autosaveDelayMs: 10_000 }),
      selectCandidates: async () => [],
      loadMetadataPolicy: async () => "strip",
    });
    const prepared = await runtime.prepareEditor();
    if (prepared.status !== "prepared") return;
    prepared.editing.dispatch({
      type: "commit",
      intent: { type: "canvas.change-background", color: "#123456" },
    });

    await expect(runtime.flush()).resolves.toEqual({
      status: "flush-failed",
      reason: "storage-failed",
      message: "disk full",
    });
    await expect(runtime.restore()).resolves.toMatchObject({
      status: "restored",
      document: { canvas: { backgroundColor: "#123456" } },
    });
  });

  it("flushes the current Draft before publishing and locating the next Draft", async () => {
    const events: string[] = [];
    const currentDocument = createDocument([
      { id: testImageId, width: 4000, height: 3000 },
    ]);
    const created = createdDraft();
    const library: DraftLibrary = {
      create: jest.fn(async () => {
        events.push("create");
        return created;
      }),
      ingest: jest.fn(),
      save: jest.fn(async (_id, document) => {
        events.push("save-current");
        return { status: "saved" as const, document };
      }),
      read: jest.fn(async (id) => {
        if (id === nextDraftId) {
          events.push("open-next");
          return {
            status: "ready" as const,
            draftId: created.draftId,
            document: created.document,
            assets: created.assets,
          };
        }
        return {
          status: "ready" as const,
          draftId: testDraftId,
          document: currentDocument,
          assets: snapshot("memory://current"),
        };
      }),
      readPreview: jest.fn(async () => ({
        status: "ready" as const,
        descriptor: snapshot("memory://current").resolve(testImageId, "preview")!,
        assets: snapshot("memory://current"),
      })),
    };
    const runtime = new EditorRuntime({
      storage: {
        library,
        readRecentDraftId: async () => testDraftId,
        writeRecentDraftId: async () => {
          events.push("locator");
        },
      },
      session: createCurrentEditingSession({ library, autosaveDelayMs: 10_000 }),
      selectCandidates: async () => [pickerCandidate],
      loadMetadataPolicy: async () => "strip",
    });
    const prepared = await runtime.prepareEditor();
    if (prepared.status !== "prepared") return;
    prepared.editing.dispatch({
      type: "commit",
      intent: { type: "canvas.change-background", color: "#112233" },
    });

    await expect(runtime.choosePhotos()).resolves.toMatchObject({ status: "created" });

    expect(events).toEqual(["save-current", "create", "locator", "open-next"]);
    await expect(runtime.restore()).resolves.toMatchObject({
      status: "restored",
      draftId: nextDraftId,
    });
  });

  it("does not create a new Draft when the current Draft cannot flush", async () => {
    let saveFails = true;
    const currentDocument = createDocument([
      { id: testImageId, width: 4000, height: 3000 },
    ]);
    const create = jest.fn(async () => createdDraft());
    const save = jest.fn(async (_id, document) =>
      saveFails
        ? ({ status: "save-failed", reason: "storage-failed" } as const)
        : ({ status: "saved", document } as const),
    );
    const library: DraftLibrary = {
      create,
      ingest: jest.fn(),
      save,
      read: jest.fn(async () => ({
        status: "ready" as const,
        draftId: testDraftId,
        document: currentDocument,
        assets: snapshot("memory://current"),
      })),
      readPreview: jest.fn(async () => ({
        status: "ready" as const,
        descriptor: snapshot("memory://current").resolve(testImageId, "preview")!,
        assets: snapshot("memory://current"),
      })),
    };
    const writeRecentDraftId = jest.fn(async () => undefined);
    const runtime = new EditorRuntime({
      storage: {
        library,
        readRecentDraftId: async () => testDraftId,
        writeRecentDraftId,
      },
      session: createCurrentEditingSession({ library, autosaveDelayMs: 10_000 }),
      selectCandidates: async () => [pickerCandidate],
      loadMetadataPolicy: async () => "strip",
    });
    const prepared = await runtime.prepareEditor();
    if (prepared.status !== "prepared") return;
    prepared.editing.dispatch({
      type: "commit",
      intent: { type: "canvas.change-background", color: "#112233" },
    });

    await expect(runtime.choosePhotos()).rejects.toThrow("storage-failed");
    expect(create).not.toHaveBeenCalled();
    expect(writeRecentDraftId).not.toHaveBeenCalled();

    saveFails = false;
    prepared.editing.dispatch({
      type: "commit",
      intent: { type: "canvas.change-background", color: "#223344" },
    });
    await expect(runtime.flush()).resolves.toEqual({ status: "flushed" });
    expect(save.mock.calls.at(-1)?.[1].canvas.backgroundColor).toBe("#223344");
    await expect(runtime.restore()).resolves.toMatchObject({
      status: "restored",
      draftId: testDraftId,
    });
  });

  it("keeps the current session when the created Draft locator cannot persist", async () => {
    const currentDocument = createDocument([
      { id: testImageId, width: 4000, height: 3000 },
    ]);
    const created = createdDraft();
    const read = jest.fn(async (id: typeof testDraftId) => {
      if (id === nextDraftId) {
        return {
          status: "ready" as const,
          draftId: created.draftId,
          document: created.document,
          assets: created.assets,
        };
      }
      return {
        status: "ready" as const,
        draftId: testDraftId,
        document: currentDocument,
        assets: snapshot("memory://current"),
      };
    });
    const library: DraftLibrary = {
      create: jest.fn(async () => created),
      ingest: jest.fn(),
      save: jest.fn(async (_id, document) => ({
        status: "saved" as const,
        document,
      })),
      read,
      readPreview: jest.fn(async () => ({
        status: "ready" as const,
        descriptor: snapshot("memory://current").resolve(testImageId, "preview")!,
        assets: snapshot("memory://current"),
      })),
    };
    const runtime = new EditorRuntime({
      storage: {
        library,
        readRecentDraftId: async () => testDraftId,
        writeRecentDraftId: async () => {
          throw new Error("locator write failed");
        },
      },
      session: createCurrentEditingSession({ library, autosaveDelayMs: 10_000 }),
      selectCandidates: async () => [pickerCandidate],
      loadMetadataPolicy: async () => "strip",
      readMetadataText: async () => null,
    });
    await expect(runtime.prepareEditor()).resolves.toMatchObject({ status: "prepared" });

    await expect(runtime.choosePhotos()).rejects.toThrow("locator write failed");

    expect(read).not.toHaveBeenCalledWith(nextDraftId);
    await expect(runtime.restore()).resolves.toMatchObject({
      status: "restored",
      draftId: testDraftId,
      document: currentDocument,
    });
  });

  it("restores the previous locator when the created Draft cannot open", async () => {
    const currentDocument = createDocument([
      { id: testImageId, width: 4000, height: 3000 },
    ]);
    const created = createdDraft();
    const library: DraftLibrary = {
      create: jest.fn(async () => created),
      ingest: jest.fn(),
      save: jest.fn(async (_id, document) => ({
        status: "saved" as const,
        document,
      })),
      read: jest.fn(async (id) =>
        id === nextDraftId
          ? ({ status: "recovery-failed", reason: "draft-not-found" } as const)
          : ({
              status: "ready" as const,
              draftId: testDraftId,
              document: currentDocument,
              assets: snapshot("memory://current"),
            } as const),
      ),
      readPreview: jest.fn(async () => ({
        status: "ready" as const,
        descriptor: snapshot("memory://current").resolve(testImageId, "preview")!,
        assets: snapshot("memory://current"),
      })),
    };
    const writtenLocators: (typeof testDraftId)[] = [];
    const runtime = new EditorRuntime({
      storage: {
        library,
        readRecentDraftId: async () => testDraftId,
        writeRecentDraftId: async (id) => {
          writtenLocators.push(id);
        },
      },
      session: createCurrentEditingSession({ library, autosaveDelayMs: 10_000 }),
      selectCandidates: async () => [pickerCandidate],
      loadMetadataPolicy: async () => "strip",
      readMetadataText: async () => null,
    });
    await expect(runtime.prepareEditor()).resolves.toMatchObject({ status: "prepared" });

    await expect(runtime.choosePhotos()).rejects.toThrow(
      "created Draft could not become current: draft-not-found",
    );

    expect(writtenLocators).toEqual([nextDraftId, testDraftId]);
    await expect(runtime.restore()).resolves.toMatchObject({
      status: "restored",
      draftId: testDraftId,
      document: currentDocument,
    });
  });
});
