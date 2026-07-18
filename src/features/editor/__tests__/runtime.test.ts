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
const testImageId = importedAssetId("image:1");

function snapshot(uri: string): AssetCatalogSnapshot {
  return Object.freeze({
    entries: Object.freeze([testImageId]),
    resolve: (
      assetId: Parameters<AssetCatalogSnapshot["resolve"]>[0],
      usage: Parameters<AssetCatalogSnapshot["resolve"]>[1],
    ) =>
      assetId === testImageId
        ? { draftId: testDraftId, assetId, usage, uri: `${uri}/${usage}` }
        : null,
  });
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
      session: createCurrentEditingSession({ library, autosaveDelayMs: 10_000 }),
      selectCandidates: async () => [],
      loadMetadataPolicy: async () => "strip",
      readMetadataText: async () => null,
    });

    const prepared = await runtime.prepareEditor();

    expect(library.readPreview).toHaveBeenCalledWith(testDraftId, testImageId);
    expect(prepared?.assets).not.toBe(initialAssets);
    expect(prepared?.assets).not.toBe(rebuiltAssets);
    expect(prepared?.assets.resolve(testImageId, "preview")?.uri).toBe(
      "memory://after/preview",
    );
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
      session: createCurrentEditingSession({ library, autosaveDelayMs: 10_000 }),
      selectCandidates: async () => candidates,
      loadMetadataPolicy: async () => "retain-basic",
      readMetadataText: async () => null,
    });

    await runtime.choosePhotos();

    expect(create).toHaveBeenCalledWith(candidates, { metadataPolicy: "retain-basic" });
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
      readMetadataText: async () => null,
    });

    await expect(runtime.choosePhotos()).resolves.toEqual({
      status: "not-created",
      errors: [],
    });
    expect(loadMetadataPolicy).not.toHaveBeenCalled();
    expect(library.create).not.toHaveBeenCalled();
  });

  it("opens a created Draft before publishing its recent locator", async () => {
    const candidates: readonly ImportCandidate[] = [
      { uri: "picker://one.jpg", width: 100, height: 100, kind: "image" },
    ];
    const document = createDocument([{ id: testImageId, width: 100, height: 100 }]);
    const assets = snapshot("memory://created");
    const calls: string[] = [];
    const library: DraftLibrary = {
      create: jest.fn(async () => ({
        status: "created" as const,
        draftId: testDraftId,
        document,
        assets,
        errors: [],
      })),
      ingest: jest.fn(),
      save: jest.fn(),
      read: jest.fn(async () => {
        calls.push("open");
        return {
          status: "ready" as const,
          draftId: testDraftId,
          document,
          assets,
        };
      }),
      readPreview: jest.fn(async () => ({
        status: "ready" as const,
        descriptor: assets.resolve(testImageId, "preview")!,
        assets,
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
      selectCandidates: async () => candidates,
      loadMetadataPolicy: async () => "strip",
      readMetadataText: async () => null,
    });

    await expect(runtime.choosePhotos()).resolves.toMatchObject({ status: "created" });
    expect(calls).toEqual(["open", "locator"]);
    expect((await runtime.prepareEditor())?.editing.read().document).toEqual(document);
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
      readMetadataText: async () => null,
    });
    const restored = await runtime.restore();
    if (restored.status !== "restored") return;
    const prepared = await runtime.prepareEditor();
    const editing = prepared?.editing;
    if (editing === undefined) return;
    editing.dispatch({
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
});
