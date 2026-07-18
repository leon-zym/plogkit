import { createDocument, importedAssetId } from "@/core/document";
import {
  draftId,
  type AssetCatalogSnapshot,
  type CreateDraftResult,
  type DraftLibrary,
  type ImportCandidate,
} from "@/services/drafts/draftLibrary";

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
    const document = createDocument([
      { id: importedAssetId("image:1"), width: 4000, height: 3000 },
    ]);
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
      selectCandidates: async () => [],
      loadMetadataPolicy: async () => "strip",
      readMetadataText: async () => null,
    });

    const prepared = await runtime.prepareEditor();

    expect(library.readPreview).toHaveBeenCalledWith(testDraftId, testImageId);
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    expect(prepared.assets).toBe(rebuiltAssets);
    expect(prepared.assets.resolve(testImageId, "preview")?.uri).toBe(
      "memory://after/preview",
    );
  });

  it("returns a typed preview failure while preserving the active Draft", async () => {
    const document = createDocument([
      { id: importedAssetId("image:1"), width: 4000, height: 3000 },
    ]);
    const initialAssets = snapshot("memory://before");
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
        status: "preview-failed" as const,
        reason: "preview-unavailable" as const,
        message: "decode failed",
      })),
    };
    const runtime = new EditorRuntime({
      storage: {
        library,
        readRecentDraftId: async () => testDraftId,
        writeRecentDraftId: async () => undefined,
      },
      selectCandidates: async () => [],
      loadMetadataPolicy: async () => "strip",
      readMetadataText: async () => null,
    });

    const prepared = await runtime.prepareEditor();
    const restored = await runtime.restore();

    expect(prepared).toEqual({
      status: "preview-failed",
      reason: "preview-unavailable",
      message: "decode failed",
    });
    expect(restored).toMatchObject({
      status: "restored",
      draftId: testDraftId,
      document,
    });
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
      selectCandidates: async () => [],
      loadMetadataPolicy: async () => "strip",
      readMetadataText: async () => null,
    });

    expect(await runtime.prepareEditor()).toEqual({ status: "no-draft" });
  });

  it("passes the explicit global metadata default into Draft creation", async () => {
    const candidates: readonly ImportCandidate[] = [
      {
        uri: "picker://one.jpg",
        width: 100,
        height: 100,
        kind: "image",
      },
    ];
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
      selectCandidates: async () => candidates,
      loadMetadataPolicy: async () => "retain-basic",
      readMetadataText: async () => null,
    });

    await runtime.choosePhotos();

    expect(create).toHaveBeenCalledWith(candidates, { metadataPolicy: "retain-basic" });
  });

  it("flushes the current Draft before publishing and locating the next Draft", async () => {
    const events: string[] = [];
    const currentDocument = createDocument([
      { id: testImageId, width: 4000, height: 3000 },
    ]);
    const library: DraftLibrary = {
      create: jest.fn(async () => {
        events.push("create");
        return createdDraft();
      }),
      ingest: jest.fn(),
      save: jest.fn(async (_id, document) => {
        events.push("save-current");
        return { status: "saved" as const, document };
      }),
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
    const runtime = new EditorRuntime({
      storage: {
        library,
        readRecentDraftId: async () => testDraftId,
        writeRecentDraftId: async () => {
          events.push("write-locator");
        },
      },
      selectCandidates: async () => [pickerCandidate],
      loadMetadataPolicy: async () => "strip",
      readMetadataText: async () => null,
    });
    const prepared = await runtime.prepareEditor();
    if (prepared.status !== "prepared") return;
    prepared.editing.dispatch({
      type: "commit",
      intent: { type: "canvas.change-background", color: "#112233" },
    });

    const result = await runtime.choosePhotos();

    expect(result.status).toBe("created");
    expect(events).toEqual(["save-current", "create", "write-locator"]);
    expect(await runtime.restore()).toMatchObject({
      status: "restored",
      draftId: nextDraftId,
    });
  });

  it("does not publish a new Draft when the current Draft cannot flush", async () => {
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
    const runtime = new EditorRuntime({
      storage: {
        library,
        readRecentDraftId: async () => testDraftId,
        writeRecentDraftId: jest.fn(),
      },
      selectCandidates: async () => [pickerCandidate],
      loadMetadataPolicy: async () => "strip",
      readMetadataText: async () => null,
    });
    const prepared = await runtime.prepareEditor();
    if (prepared.status !== "prepared") return;
    prepared.editing.dispatch({
      type: "commit",
      intent: { type: "canvas.change-background", color: "#112233" },
    });

    await expect(runtime.choosePhotos()).rejects.toThrow("storage-failed");
    expect(create).not.toHaveBeenCalled();
    saveFails = false;
    prepared.editing.dispatch({
      type: "commit",
      intent: { type: "canvas.change-background", color: "#223344" },
    });
    await runtime.flush();

    expect(save.mock.calls.at(-1)?.[1].canvas.backgroundColor).toBe("#223344");
    expect(await runtime.restore()).toMatchObject({
      status: "restored",
      draftId: testDraftId,
    });
  });

  it("keeps the current Draft active when the next Draft fails to create", async () => {
    const currentDocument = createDocument([
      { id: testImageId, width: 4000, height: 3000 },
    ]);
    const save = jest.fn(async (_id, document) => ({ status: "saved" as const, document }));
    const library: DraftLibrary = {
      create: jest.fn(async () => ({
        status: "create-failed" as const,
        message: "disk full",
        errors: [],
      })),
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
      selectCandidates: async () => [pickerCandidate],
      loadMetadataPolicy: async () => "strip",
      readMetadataText: async () => null,
    });
    const prepared = await runtime.prepareEditor();
    if (prepared.status !== "prepared") return;

    expect((await runtime.choosePhotos()).status).toBe("create-failed");
    expect(writeRecentDraftId).not.toHaveBeenCalled();
    prepared.editing.dispatch({
      type: "commit",
      intent: { type: "canvas.change-background", color: "#334455" },
    });
    await runtime.flush();

    expect(save.mock.calls.at(-1)?.[1].canvas.backgroundColor).toBe("#334455");
    expect(await runtime.restore()).toMatchObject({ draftId: testDraftId });
  });

  it("keeps the current Draft active when the recent locator cannot publish", async () => {
    const currentDocument = createDocument([
      { id: testImageId, width: 4000, height: 3000 },
    ]);
    const save = jest.fn(async (_id, document) => ({ status: "saved" as const, document }));
    const library: DraftLibrary = {
      create: jest.fn(async () => createdDraft()),
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
    const runtime = new EditorRuntime({
      storage: {
        library,
        readRecentDraftId: async () => testDraftId,
        writeRecentDraftId: async () => {
          throw new Error("locator unavailable");
        },
      },
      selectCandidates: async () => [pickerCandidate],
      loadMetadataPolicy: async () => "strip",
      readMetadataText: async () => null,
    });
    const prepared = await runtime.prepareEditor();
    if (prepared.status !== "prepared") return;

    await expect(runtime.choosePhotos()).rejects.toThrow("locator unavailable");
    prepared.editing.dispatch({
      type: "commit",
      intent: { type: "canvas.change-background", color: "#445566" },
    });
    await runtime.flush();

    expect(save.mock.calls.at(-1)?.[1].canvas.backgroundColor).toBe("#445566");
    expect(await runtime.restore()).toMatchObject({
      status: "restored",
      draftId: testDraftId,
    });
  });
});
