import {
  ImageFormat,
  Skia,
  type SkImage,
  type SkSurface,
} from "@shopify/react-native-skia";

import { getDeviceTextLayoutEnvironment } from "../../render/deviceTextLayout";
import { documentToRenderScene } from "../../render/scene";
import { drawSceneBackground, drawSceneImage, drawTextLayout } from "../../render/skiaDraw";
import {
  createTextLayoutSnapshot,
  type AnyTextLayoutEnvironment,
  type TextLayoutSnapshot,
} from "../../render/textLayout";
import { parseImageMetadataSidecar, toExifDateTime } from "../image-import/metadata";
import { SKIA_EXPORT_CAPABILITIES } from "./capabilities";
import { injectBasicExif, type BasicExifMetadata } from "./exif";
import type {
  BackendExportResult,
  ExportBackend,
  ExportBackendInput,
} from "./types";

type SkiaApi = typeof Skia;

export interface CreateSkiaExportBackendOptions {
  readonly api?: SkiaApi;
  readonly makeSurface?: (width: number, height: number) => SkSurface | null;
  readonly loadImage?: (uri: string) => Promise<SkImage | null>;
  readonly getTextLayoutEnvironment?: () => AnyTextLayoutEnvironment;
  readonly readMetadataText?: (uri: string) => Promise<string | null>;
}

class AssetUnavailableError extends Error {}

class ExportCancelledError extends Error {
  readonly phase: "assets" | "render" | "encode";

  constructor(phase: "assets" | "render" | "encode") {
    super(`export cancelled during ${phase}`);
    this.phase = phase;
  }
}

async function defaultLoadImage(api: SkiaApi, uri: string): Promise<SkImage | null> {
  const data = await api.Data.fromURI(uri);
  try {
    return api.Image.MakeImageFromEncoded(data);
  } finally {
    data.dispose();
  }
}

function checkCancellation(
  signal: AbortSignal | undefined,
  phase: "assets" | "render" | "encode",
): void {
  if (signal?.aborted === true) throw new ExportCancelledError(phase);
}

async function readBasicMetadata(
  input: ExportBackendInput,
  readMetadataText: (uri: string) => Promise<string | null>,
): Promise<BasicExifMetadata> {
  const firstImage = input.document.sourceImages[0];
  if (firstImage === undefined) return {};
  const descriptor = input.assets.resolve(firstImage.id, "metadata");
  if (descriptor === null) return {};
  try {
    const text = await readMetadataText(descriptor.uri);
    if (text === null) return {};
    const metadata = parseImageMetadataSidecar(JSON.parse(text) as unknown);
    if (metadata === null) return {};
    return {
      dateTimeOriginal: toExifDateTime(metadata.capturedAt),
      make: metadata.deviceMake,
      model: metadata.deviceModel,
    };
  } catch {
    return {};
  }
}

async function renderDocument(
  input: ExportBackendInput,
  api: SkiaApi,
  makeSurface: (width: number, height: number) => SkSurface | null,
  loadImage: (uri: string) => Promise<SkImage | null>,
  textLayoutEnvironment: AnyTextLayoutEnvironment,
): Promise<SkImage> {
  const scene = documentToRenderScene(input.document);
  const textLayoutResult = createTextLayoutSnapshot(textLayoutEnvironment, scene.texts);
  if (textLayoutResult.status === "failure") {
    throw new Error(`export text layout failed: ${textLayoutResult.message}`);
  }
  const textLayout: TextLayoutSnapshot = textLayoutResult.snapshot;
  let surface: SkSurface | null = null;
  try {
    checkCancellation(input.signal, "render");
    surface = makeSurface(input.policy.width, input.policy.height);
    if (surface === null) {
      throw new Error(
        `could not create ${input.policy.width}x${input.policy.height} CPU export surface`,
      );
    }
    const canvas = surface.getCanvas();
    canvas.scale(input.policy.width / scene.width, input.policy.height / scene.height);
    drawSceneBackground(api, canvas, scene);

    for (const node of scene.images) {
      checkCancellation(input.signal, "assets");
      const descriptor = input.assets.resolve(node.imageId, "original");
      if (descriptor === null) {
        throw new AssetUnavailableError(`original asset ${node.imageId} is unavailable`);
      }
      let image: SkImage | null;
      try {
        image = await loadImage(descriptor.uri);
      } catch (error: unknown) {
        throw new AssetUnavailableError(`original asset ${node.imageId} could not load`, {
          cause: error,
        });
      }
      if (image === null) {
        throw new AssetUnavailableError(`original asset ${node.imageId} could not decode`);
      }
      try {
        checkCancellation(input.signal, "assets");
        drawSceneImage(api, canvas, node, image);
        surface.flush();
      } finally {
        image.dispose();
      }
    }

    checkCancellation(input.signal, "render");
    for (const layout of textLayout.layouts) drawTextLayout(canvas, layout);
    surface.flush();
    return surface.makeImageSnapshot();
  } finally {
    textLayout.dispose();
    surface?.dispose();
  }
}

async function encodeSnapshot(
  input: ExportBackendInput,
  snapshot: SkImage,
  readMetadataText: (uri: string) => Promise<string | null>,
): Promise<Uint8Array> {
  checkCancellation(input.signal, "encode");
  const format = input.policy.format === "jpeg" ? ImageFormat.JPEG : ImageFormat.PNG;
  const encoded = snapshot.encodeToBytes(format, Math.round(input.policy.quality * 100));
  if (encoded.length === 0) throw new Error("Skia produced an empty encoded image");
  if (input.policy.metadataPolicy !== "retain-basic") return encoded;
  const metadata = await readBasicMetadata(input, readMetadataText);
  checkCancellation(input.signal, "encode");
  return injectBasicExif(encoded, metadata);
}

/** One SDR/sRGB static-image backend that privately owns render and encode resources. */
export function createSkiaExportBackend(
  options: CreateSkiaExportBackendOptions = {},
): ExportBackend {
  const api = options.api ?? Skia;
  const makeSurface =
    options.makeSurface ?? ((width, height) => api.Surface.Make(width, height));
  const loadImage = options.loadImage ?? ((uri) => defaultLoadImage(api, uri));
  const getTextLayoutEnvironment =
    options.getTextLayoutEnvironment ?? getDeviceTextLayoutEnvironment;
  const readMetadataText = options.readMetadataText ?? (async () => null);

  const prepare = async (input: ExportBackendInput): Promise<BackendExportResult> => {
    try {
      checkCancellation(input.signal, "assets");
      let snapshot: SkImage | null = null;
      try {
        snapshot = await renderDocument(
          input,
          api,
          makeSurface,
          loadImage,
          getTextLayoutEnvironment(),
        );
      } catch (error: unknown) {
        if (error instanceof ExportCancelledError) {
          return { status: "cancelled", phase: error.phase };
        }
        if (error instanceof AssetUnavailableError) {
          return { status: "failure", code: "asset-unavailable", phase: "assets" };
        }
        return { status: "failure", code: "render-failed", phase: "render" };
      }

      let bytes: Uint8Array;
      try {
        bytes = await encodeSnapshot(input, snapshot, readMetadataText);
      } catch (error: unknown) {
        if (error instanceof ExportCancelledError) {
          return { status: "cancelled", phase: error.phase };
        }
        return { status: "failure", code: "encode-failed", phase: "encode" };
      } finally {
        snapshot.dispose();
      }

      const prepared = await input.operation.prepareStaticImage({
        bytes,
        mimeType: input.policy.mimeType,
        extension: input.policy.extension,
      });
      return { status: "prepared", prepared };
    } catch (error: unknown) {
      if (error instanceof ExportCancelledError) {
        return { status: "cancelled", phase: error.phase };
      }
      throw error;
    }
  };

  return Object.freeze({
    identity: Object.freeze({ id: "skia-static", revision: 1 }),
    capabilities: SKIA_EXPORT_CAPABILITIES,
    prepare,
  });
}
