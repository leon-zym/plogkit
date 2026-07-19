import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LoadSkiaWeb } from "@shopify/react-native-skia/lib/commonjs/web/LoadSkiaWeb";
import {
  getSkiaExports,
  makeOffscreenSurface,
} from "@shopify/react-native-skia/lib/commonjs/headless";

import { createDocument, importedAssetId } from "../src/core/document";
import { resolveExportPolicy } from "../src/core/exportPolicy";
import { documentToExportSourceFacts } from "../src/render/exportSourceFacts";
import {
  compareGoldenPng,
  createHeadlessFontProvider,
  createHeadlessTextLayoutEnvironment,
  renderHeadlessScene,
} from "../src/render/headless";
import { documentToRenderScene } from "../src/render/scene";

jest.mock("@shopify/react-native-skia", () => {
  const headless = jest.requireActual(
    "@shopify/react-native-skia/lib/commonjs/headless",
  );
  return {
    ...headless,
    Skia: headless.getSkiaExports().Skia,
  };
});

const ONE_PIXEL_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const FONT_DIR = join(__dirname, "fonts");

function containsAscii(bytes, value) {
  return Buffer.from(bytes).includes(Buffer.from(value, "ascii"));
}

function createOperation() {
  const preparedBytes = [];
  return {
    operation: {
      id: "contract",
      directoryUri: "cache:///exports/contract",
      prepareStaticImage: jest.fn(async ({ bytes, mimeType, extension }) => {
        preparedBytes.push(bytes);
        return {
          kind: "static-image",
          operationId: "contract",
          uri: `cache:///exports/contract/output.${extension}`,
          mimeType,
          extension,
        };
      }),
      cleanup: jest.fn(async () => undefined),
    },
    preparedBytes,
  };
}

function resolvedPolicy(document, backend) {
  const resolution = resolveExportPolicy(
    document.exportSettings,
    documentToExportSourceFacts(document),
    backend.capabilities,
  );
  if (resolution.status !== "resolved") throw new Error("test policy did not resolve");
  return resolution.policy;
}

describe("Skia export backend contract", () => {
  let api;
  let createSkiaExportBackend;
  let fontProvider;
  let textLayoutEnvironment;

  beforeAll(async () => {
    await LoadSkiaWeb();
    api = getSkiaExports().Skia;
    ({ createSkiaExportBackend } = require("../src/services/export/skiaBackend"));
    fontProvider = createHeadlessFontProvider([
      {
        family: "Test Latin",
        bytes: Uint8Array.from(readFileSync(join(FONT_DIR, "NotoSans-TestSubset.ttf"))),
      },
      {
        family: "Test CJK",
        bytes: Uint8Array.from(readFileSync(join(FONT_DIR, "NotoSansSC-TestSubset.ttf"))),
      },
    ]);
    textLayoutEnvironment = createHeadlessTextLayoutEnvironment(fontProvider, {
      "system-sans": ["Test Latin", "Test CJK"],
    });
  });

  afterAll(() => {
    fontProvider.dispose();
  });

  function loadFixture() {
    const data = api.Data.fromBytes(ONE_PIXEL_PNG);
    try {
      return Promise.resolve(api.Image.MakeImageFromEncoded(data));
    } finally {
      data.dispose();
    }
  }

  it("matches shared rendered pixels and releases input, surface, and snapshot", async () => {
    const imageId = importedAssetId("backend-png");
    const baseDocument = createDocument([{ id: imageId, width: 96, height: 128 }]);
    const document = {
      ...baseDocument,
      canvas: { ratio: "1:1", backgroundColor: "#C43D52" },
      textElements: [
        {
          id: "caption",
          content: "AB周末",
          position: { x: 220, y: 300 },
          width: 560,
          fontId: "system-sans",
          fontSize: 96,
          color: "#101010",
          alignment: "center",
          lineHeight: 1.15,
          backgroundColor: "#F6F1E8CC",
        },
      ],
      exportSettings: {
        ...baseDocument.exportSettings,
        formatOverride: "png",
      },
    };
    const surfaceDispose = jest.fn();
    const snapshotDispose = jest.fn();
    let inputDispose;
    const backend = createSkiaExportBackend({
      api,
      getTextLayoutEnvironment: () => textLayoutEnvironment,
      loadImage: async () => {
        const image = await loadFixture();
        inputDispose = jest.spyOn(image, "dispose");
        return image;
      },
      makeSurface: (width, height) => {
        const surface = makeOffscreenSurface(width, height);
        return {
          getCanvas: () => surface.getCanvas(),
          flush: () => surface.flush(),
          makeImageSnapshot: () => {
            const snapshot = surface.makeImageSnapshot();
            return {
              encodeToBytes: (format, quality) => snapshot.encodeToBytes(format, quality),
              dispose: () => {
                snapshotDispose();
                snapshot.dispose();
              },
            };
          },
          dispose: () => {
            surfaceDispose();
            surface.dispose();
          },
        };
      },
    });
    const assets = {
      entries: [imageId],
      resolve: (candidateId, usage) =>
        candidateId === imageId
          ? { draftId: "draft-backend", assetId: imageId, usage, uri: "fixture://one" }
          : null,
    };
    const { operation, preparedBytes } = createOperation();
    const policy = resolvedPolicy(document, backend);

    const result = await backend.prepare({
      document,
      assets,
      policy,
      operation,
    });

    expect(result.status).toBe("prepared");
    const expected = await renderHeadlessScene(
      documentToRenderScene(document),
      new Map([[imageId, ONE_PIXEL_PNG]]),
      {
        width: policy.width,
        height: policy.height,
        textLayoutEnvironment,
      },
    );
    const comparison = compareGoldenPng(preparedBytes[0], expected);
    const data = api.Data.fromBytes(preparedBytes[0]);
    const decoded = api.Image.MakeImageFromEncoded(data);
    data.dispose();
    expect(decoded).not.toBeNull();
    expect(decoded.width()).toBe(policy.width);
    expect(decoded.height()).toBe(policy.height);
    decoded.dispose();
    expect(comparison.changedPixels).toBe(0);
    expect(preparedBytes[0].slice(1, 4)).toEqual(Uint8Array.from([0x50, 0x4e, 0x47]));
    expect(inputDispose).toHaveBeenCalledTimes(1);
    expect(surfaceDispose).toHaveBeenCalledTimes(1);
    expect(snapshotDispose).toHaveBeenCalledTimes(1);
  });

  it("retains only basic JPEG metadata from the Draft sidecar", async () => {
    const imageId = importedAssetId("backend-jpeg");
    const document = {
      ...createDocument([{ id: imageId, width: 64, height: 48 }]),
      exportSettings: {
        ...createDocument().exportSettings,
        metadataPolicy: "retain-basic",
      },
    };
    const backend = createSkiaExportBackend({
      api,
      getTextLayoutEnvironment: () => textLayoutEnvironment,
      loadImage: loadFixture,
      makeSurface: makeOffscreenSurface,
      readMetadataText: async () =>
        JSON.stringify({
          capturedAt: "2026-07-18T09:10:11+08:00",
          deviceMake: "PlogCam",
          deviceModel: "One",
          lensModel: "Private Lens",
        }),
    });
    const assets = {
      entries: [imageId],
      resolve: (candidateId, usage) =>
        candidateId === imageId
          ? {
              draftId: "draft-metadata",
              assetId: imageId,
              usage,
              uri: usage === "metadata" ? "fixture://metadata" : "fixture://one",
            }
          : null,
    };
    const { operation, preparedBytes } = createOperation();

    const result = await backend.prepare({
      document,
      assets,
      policy: resolvedPolicy(document, backend),
      operation,
    });

    expect(result.status).toBe("prepared");
    expect(containsAscii(preparedBytes[0], "Exif")).toBe(true);
    expect(containsAscii(preparedBytes[0], "PlogCam")).toBe(true);
    expect(containsAscii(preparedBytes[0], "Private Lens")).toBe(false);
  });

  it("returns asset-unavailable without writing a PreparedExport", async () => {
    const imageId = importedAssetId("backend-missing");
    const document = createDocument([{ id: imageId, width: 64, height: 48 }]);
    const backend = createSkiaExportBackend({
      api,
      getTextLayoutEnvironment: () => textLayoutEnvironment,
      makeSurface: makeOffscreenSurface,
    });
    const { operation } = createOperation();

    await expect(
      backend.prepare({
        document,
        assets: { entries: [], resolve: () => null },
        policy: resolvedPolicy(document, backend),
        operation,
      }),
    ).resolves.toEqual({
      status: "failure",
      code: "asset-unavailable",
      phase: "assets",
    });
    expect(operation.prepareStaticImage).not.toHaveBeenCalled();
  });

  it("releases the input image, snapshot, and surface when encoding fails", async () => {
    const imageId = importedAssetId("backend-encode-failure");
    const document = createDocument([{ id: imageId, width: 64, height: 48 }]);
    const inputDispose = jest.fn();
    const snapshotDispose = jest.fn();
    const surfaceDispose = jest.fn();
    const backend = createSkiaExportBackend({
      api,
      getTextLayoutEnvironment: () => textLayoutEnvironment,
      loadImage: async () => {
        const image = await loadFixture();
        const dispose = image.dispose.bind(image);
        image.dispose = () => {
          inputDispose();
          dispose();
        };
        return image;
      },
      makeSurface: (width, height) => {
        const surface = makeOffscreenSurface(width, height);
        return {
          getCanvas: () => surface.getCanvas(),
          flush: () => surface.flush(),
          makeImageSnapshot: () => {
            const snapshot = surface.makeImageSnapshot();
            return {
              encodeToBytes: () => {
                throw new Error("encode failed");
              },
              dispose: () => {
                snapshotDispose();
                snapshot.dispose();
              },
            };
          },
          dispose: () => {
            surfaceDispose();
            surface.dispose();
          },
        };
      },
    });
    const { operation } = createOperation();

    await expect(
      backend.prepare({
        document,
        assets: {
          entries: [imageId],
          resolve: (candidateId, usage) =>
            candidateId === imageId
              ? { draftId: "draft-failure", assetId: imageId, usage, uri: "fixture://one" }
              : null,
        },
        policy: resolvedPolicy(document, backend),
        operation,
      }),
    ).resolves.toEqual({ status: "failure", code: "encode-failed", phase: "encode" });
    expect(inputDispose).toHaveBeenCalledTimes(1);
    expect(snapshotDispose).toHaveBeenCalledTimes(1);
    expect(surfaceDispose).toHaveBeenCalledTimes(1);
    expect(operation.prepareStaticImage).not.toHaveBeenCalled();
  });

  it("releases the loaded input and surface when cancellation wins after asset loading", async () => {
    const imageId = importedAssetId("backend-cancelled");
    const document = createDocument([{ id: imageId, width: 64, height: 48 }]);
    const controller = new AbortController();
    const inputDispose = jest.fn();
    const surfaceDispose = jest.fn();
    const backend = createSkiaExportBackend({
      api,
      getTextLayoutEnvironment: () => textLayoutEnvironment,
      loadImage: async () => {
        const image = await loadFixture();
        const dispose = image.dispose.bind(image);
        image.dispose = () => {
          inputDispose();
          dispose();
        };
        controller.abort();
        return image;
      },
      makeSurface: (width, height) => {
        const surface = makeOffscreenSurface(width, height);
        return {
          getCanvas: () => surface.getCanvas(),
          flush: () => surface.flush(),
          makeImageSnapshot: () => surface.makeImageSnapshot(),
          dispose: () => {
            surfaceDispose();
            surface.dispose();
          },
        };
      },
    });
    const { operation } = createOperation();

    await expect(
      backend.prepare({
        document,
        assets: {
          entries: [imageId],
          resolve: (candidateId, usage) =>
            candidateId === imageId
              ? { draftId: "draft-cancelled", assetId: imageId, usage, uri: "fixture://one" }
              : null,
        },
        policy: resolvedPolicy(document, backend),
        operation,
        signal: controller.signal,
      }),
    ).resolves.toEqual({ status: "cancelled", phase: "assets" });
    expect(inputDispose).toHaveBeenCalledTimes(1);
    expect(surfaceDispose).toHaveBeenCalledTimes(1);
    expect(operation.prepareStaticImage).not.toHaveBeenCalled();
  });
});
