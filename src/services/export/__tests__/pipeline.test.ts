import { createDocument } from "../../../core/document";
import { SkiaExportEncodeStage } from "../encodeStage";
import { runExportPipeline } from "../pipeline";
import type {
  ExportDestination,
  ExportEncodeStage,
  ExportRenderStage,
  RenderedPixels,
} from "../types";

function makePixels(): RenderedPixels & { readonly dispose: jest.Mock<void, []> } {
  return {
    width: 4000,
    height: 3000,
    encode: jest.fn(() => new Uint8Array([1, 2, 3])),
    dispose: jest.fn(),
  };
}

describe("two-stage export orchestration", () => {
  it("renders, encodes, writes, and saves in order, then disposes rendered pixels", async () => {
    const document = createDocument([
      {
        id: "one",
        originalUri: "file:///original.jpg",
        previewUri: "file:///preview.jpg",
        width: 4000,
        height: 3000,
      },
    ]);
    const pixels = makePixels();
    const renderer: ExportRenderStage = { render: jest.fn(async () => pixels) };
    const encoder: ExportEncodeStage = {
      encode: jest.fn(() => new Uint8Array([9, 8, 7])),
    };
    const destination: ExportDestination = {
      writeAndSave: jest.fn(async () => ({ fileUri: "file:///export.jpg", assetId: "asset-1" })),
    };

    const result = await runExportPipeline(document, {}, { renderer, encoder, destination });

    expect(result).toMatchObject({
      fileUri: "file:///export.jpg",
      assetId: "asset-1",
      plan: { width: 4000, height: 3000, format: "jpeg" },
    });
    expect(pixels.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes rendered pixels when encoding or saving fails", async () => {
    const document = createDocument();
    const pixels = { ...makePixels(), width: 1000, height: 1000 };
    const renderer: ExportRenderStage = { render: async () => pixels };
    const encoder: ExportEncodeStage = { encode: () => new Uint8Array([1]) };
    const destination: ExportDestination = {
      writeAndSave: async () => {
        throw new Error("save failed");
      },
    };

    await expect(runExportPipeline(document, {}, { renderer, encoder, destination })).rejects.toThrow(
      "save failed",
    );
    expect(pixels.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects PNG retain-basic explicitly before pretending metadata was retained", () => {
    const pixels = makePixels();
    const encoder = new SkiaExportEncodeStage();

    expect(() =>
      encoder.encode(pixels, {
        presetId: "original",
        width: 4000,
        height: 3000,
        wasReduced: false,
        format: "png",
        quality: 0.95,
        metadataPolicy: "retain-basic",
        extension: "png",
        mimeType: "image/png",
      }),
    ).toThrow("not supported for PNG");
    expect(pixels.encode).not.toHaveBeenCalled();
  });
});
