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
      selectCandidates: async () => [],
      loadMetadataPolicy: async () => "strip",
      readMetadataText: async () => null,
    });

    const prepared = await runtime.prepareEditor();

    expect(library.readPreview).toHaveBeenCalledWith(testDraftId, testImageId);
    expect(prepared?.assets).toBe(rebuiltAssets);
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
      selectCandidates: async () => candidates,
      loadMetadataPolicy: async () => "retain-basic",
      readMetadataText: async () => null,
    });

    await runtime.choosePhotos();

    expect(create).toHaveBeenCalledWith(candidates, { metadataPolicy: "retain-basic" });
  });
});
