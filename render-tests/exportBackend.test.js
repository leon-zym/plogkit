import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LoadSkiaWeb } from "@shopify/react-native-skia/lib/commonjs/web/LoadSkiaWeb";
import { getSkiaExports } from "@shopify/react-native-skia/lib/commonjs/headless";

import { createDocument, importedAssetId } from "../src/core/document";
import { resolveExportPolicy } from "../src/core/exportPolicy";
import { documentToExportSourceFacts } from "../src/render/exportSourceFacts";
import {
  compareGoldenPng,
  createHeadlessFontProvider,
  createHeadlessTextLayoutEnvironment,
  renderHeadlessScene,
} from "../src/render/headless";
import { createHeadlessSkiaOffscreenSceneRenderer } from "../src/render/headlessSkiaOffscreenRenderer";
import { documentToRenderScene } from "../src/render/scene";

jest.mock("@shopify/react-native-skia", () => {
  const headless = jest.requireActual("@shopify/react-native-skia/lib/commonjs/headless");
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
const DISPLAY_P3_PNG = Uint8Array.from(
  Buffer.from(
    [
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAABGdBTUEAALGPC/xhBQAAAWNpQ0NQa0NHQ29sb3JTcGFjZURpc3BsYXlQMwAAKJF9kLFLw1AQxr9WpaB1EB0cHDKJQ5SSCro4tBVEcQhVweqUvqapkMZHkiIFN/+Bgv+BCs5uFoc6OjgIopPo5uSk4KLleS+JpCJ6j+N+fO+74zggOW5wbvcDqDu+W1zKK5ulLSX1jAS9IAzm8Zyur0r+rj/j/T703k7LWb///43Biukxqp+UGcZdH0ioxPqezyXvE4+5tBRxS7IV8onkcsjngWe9WCC+JlZYzagQvxCr5R7d6uG63WDRDnL7tOlsrMk5lBNYxA48cNgw0IQCHdk//LOBv4BdcjfhUp+FGnzqyZEiJ5jEy3DAMAOVWEOGUpN3ju53F91PjbWDJ2ChI4S4iLWVDnA2Rydrx9rUPDAyBFy1ueEagdRHmaxWgddTYLgEjN5Qz7ZXzWrh9uk8MPAoxNskkDoEui0hPo6E6B5T8wNw6XwBA6diE6SWDlsAAAAgY0hSTQAAeiYAAICEAAD6AAAAgOgAAHUwAADqYAAAOpgAABdwnLpRPAAAAARjSUNQDA0AAW4D4+8AAAA4ZVhJZk1NACoAAAAIAAGHaQAEAAAAAQAAABoAAAAAAAKgAgAEAAAAAQAAAAigAwAEAAAAAQAAAAgAAAAAtkxZaAAAANFJREFUGBlFj8FKA0EQRF/vzCwxQc2K2UM+wA/IXcSP8Re9ihHx5iEqePAgJIZsQNlINuiuO2PPXlKHhu4quqqk2hQBhbUWYxKIm0BdN4QQsJFMlHh9mvHy9q5kgrOGy4tz+v0DEgXb75Lr6R1hcIo9zpl/blkVBUa57kPT1IhzjPKc1Fl+djtE1EfRCYwxrJdLHm5v1PuXj8WcydmV2sk+Qy8Vnh/v+SpLxlnG6CTDe4/EFr5tqaoNzV+rGYWjwyHOpXtB9Iphu346Q/BdxXj/B2NAUKoNKyclAAAAAElFTkSuQmCC",
    ].join(""),
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
  let canvasKit;
  let createSkiaExportBackend;
  let fontProvider;
  let textLayoutEnvironment;

  beforeAll(async () => {
    await LoadSkiaWeb();
    canvasKit = global.CanvasKit;
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

  it("[F04-S02][F04-S11] matches the shared renderer pixels and preserves the requested static encoding", async () => {
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
    const backend = createSkiaExportBackend({
      renderer: createHeadlessSkiaOffscreenSceneRenderer(
        new Map([["fixture://one", ONE_PIXEL_PNG]]),
        textLayoutEnvironment,
      ),
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
  });

  it("[F04-S05] converts a Display P3 source into an actual SDR/sRGB encoded image", async () => {
    const imageId = importedAssetId("backend-display-p3");
    const baseDocument = createDocument([{ id: imageId, width: 8, height: 8 }]);
    const document = {
      ...baseDocument,
      exportSettings: {
        ...baseDocument.exportSettings,
        formatOverride: "png",
      },
    };
    const backend = createSkiaExportBackend({
      renderer: createHeadlessSkiaOffscreenSceneRenderer(
        new Map([["fixture://display-p3", DISPLAY_P3_PNG]]),
        textLayoutEnvironment,
      ),
    });
    const assets = {
      entries: [imageId],
      resolve: (candidateId, usage) =>
        candidateId === imageId
          ? {
              draftId: "draft-display-p3",
              assetId: imageId,
              usage,
              uri: "fixture://display-p3",
            }
          : null,
    };
    const { operation, preparedBytes } = createOperation();

    const source = canvasKit.MakeImageFromEncoded(DISPLAY_P3_PNG);
    expect(source).not.toBeNull();
    const sourceColorSpace = source.getColorSpace();
    expect(containsAscii(DISPLAY_P3_PNG, "kCGColorSpaceDisplayP3")).toBe(true);
    expect(canvasKit.ColorSpace.Equals(sourceColorSpace, canvasKit.ColorSpace.SRGB)).toBe(false);
    sourceColorSpace.delete();
    source.delete();

    const result = await backend.prepare({
      document,
      assets,
      policy: resolvedPolicy(document, backend),
      operation,
    });

    expect(result.status).toBe("prepared");
    const output = canvasKit.MakeImageFromEncoded(preparedBytes[0]);
    expect(output).not.toBeNull();
    const outputColorSpace = output.getColorSpace();
    expect(canvasKit.ColorSpace.Equals(outputColorSpace, canvasKit.ColorSpace.SRGB)).toBe(true);
    expect(canvasKit.ColorSpace.Equals(outputColorSpace, canvasKit.ColorSpace.DISPLAY_P3)).toBe(
      false,
    );
    outputColorSpace.delete();
    output.delete();
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
      renderer: createHeadlessSkiaOffscreenSceneRenderer(
        new Map([["fixture://one", ONE_PIXEL_PNG]]),
        textLayoutEnvironment,
      ),
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
      renderer: createHeadlessSkiaOffscreenSceneRenderer(new Map(), textLayoutEnvironment),
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

  it.each([
    [
      "target validation",
      {
        status: "failure",
        code: "target-invalid",
        phase: "render",
        message: "target invalid",
      },
    ],
    [
      "composition",
      {
        status: "failure",
        code: "surface-failed",
        phase: "render",
        targetId: "export",
        message: "surface unavailable",
      },
    ],
  ])("maps a shared renderer %s failure without writing a PreparedExport", async (
    _label,
    renderResult,
  ) => {
    const document = createDocument();
    const backend = createSkiaExportBackend({
      renderer: {
        render: jest.fn(async () => renderResult),
      },
    });
    const { operation } = createOperation();

    await expect(
      backend.prepare({
        document,
        assets: { entries: [], resolve: () => null },
        policy: resolvedPolicy(document, backend),
        operation,
      }),
    ).resolves.toEqual({ status: "failure", code: "render-failed", phase: "render" });
    expect(operation.prepareStaticImage).not.toHaveBeenCalled();
  });

  it("maps a shared renderer encoding failure without writing a PreparedExport", async () => {
    const imageId = importedAssetId("backend-encode-failure");
    const document = createDocument([{ id: imageId, width: 64, height: 48 }]);
    const backend = createSkiaExportBackend({
      renderer: {
        render: jest.fn(async () => ({
          status: "failure",
          code: "encode-failed",
          phase: "encode",
          targetId: "export",
          message: "encode failed",
        })),
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
    expect(operation.prepareStaticImage).not.toHaveBeenCalled();
  });

  it("[F04-S14] preserves renderer cancellation phase without writing a PreparedExport", async () => {
    const imageId = importedAssetId("backend-cancelled");
    const document = createDocument([{ id: imageId, width: 64, height: 48 }]);
    const controller = new AbortController();
    const backend = createSkiaExportBackend({
      renderer: {
        render: jest.fn(async () => ({
          status: "cancelled",
          phase: "assets",
        })),
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
    expect(operation.prepareStaticImage).not.toHaveBeenCalled();
  });
});
