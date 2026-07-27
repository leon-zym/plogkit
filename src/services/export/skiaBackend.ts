import { createDeviceSkiaOffscreenSceneRenderer } from "../../render/deviceSkiaOffscreenRenderer";
import { documentToRenderScene } from "../../render/scene";
import type {
  SkiaOffscreenFailure,
  SkiaOffscreenSceneRenderer,
} from "../../render/skiaOffscreenRenderer";
import { parseImageMetadataSidecar, toExifDateTime } from "../image-import/metadata";
import { SKIA_EXPORT_CAPABILITIES } from "./capabilities";
import { injectBasicExif, type BasicExifMetadata } from "./exif";
import type { BackendExportResult, ExportBackend, ExportBackendInput } from "./types";

export interface CreateSkiaExportBackendOptions {
  readonly renderer?: SkiaOffscreenSceneRenderer;
  readonly readMetadataText?: (uri: string) => Promise<string | null>;
}

class ExportCancelledError extends Error {
  readonly phase: "assets" | "render" | "encode";

  constructor(phase: "assets" | "render" | "encode") {
    super(`export cancelled during ${phase}`);
    this.phase = phase;
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

async function applyMetadataPolicy(
  input: ExportBackendInput,
  encoded: Uint8Array,
  readMetadataText: (uri: string) => Promise<string | null>,
): Promise<Uint8Array> {
  checkCancellation(input.signal, "encode");
  if (input.policy.metadataPolicy !== "retain-basic") return encoded;
  const metadata = await readBasicMetadata(input, readMetadataText);
  checkCancellation(input.signal, "encode");
  return injectBasicExif(encoded, metadata);
}

function mapRenderFailure(error: SkiaOffscreenFailure): BackendExportResult {
  switch (error.code) {
    case "original-asset-unavailable":
    case "original-asset-load-failed":
    case "original-asset-decode-failed":
      return { status: "failure", code: "asset-unavailable", phase: "assets" };
    case "encode-failed":
      return { status: "failure", code: "encode-failed", phase: "encode" };
    case "target-invalid":
    case "text-layout-failed":
    case "surface-failed":
    case "draw-failed":
      return { status: "failure", code: "render-failed", phase: "render" };
  }
}

/** One SDR/sRGB static-image backend that privately owns render and encode resources. */
export function createSkiaExportBackend(
  options: CreateSkiaExportBackendOptions = {},
): ExportBackend {
  const renderer = options.renderer ?? createDeviceSkiaOffscreenSceneRenderer();
  const readMetadataText = options.readMetadataText ?? (async () => null);

  const prepare = async (input: ExportBackendInput): Promise<BackendExportResult> => {
    try {
      checkCancellation(input.signal, "assets");
      const scene = documentToRenderScene(input.document);
      const rendered = await renderer.render({
        scene,
        assets: input.assets,
        targets: [
          {
            id: "export",
            width: input.policy.width,
            height: input.policy.height,
            transform: {
              scaleX: input.policy.width / scene.width,
              scaleY: input.policy.height / scene.height,
              translateX: 0,
              translateY: 0,
            },
            encoding:
              input.policy.format === "jpeg"
                ? { format: "jpeg", quality: input.policy.quality }
                : { format: "png" },
          },
        ],
        signal: input.signal,
      });
      if (rendered.status === "cancelled") {
        return rendered;
      }
      if (rendered.status === "failure") {
        return mapRenderFailure(rendered);
      }
      const output = rendered.outputs.export;
      if (output === undefined) throw new Error("Skia renderer omitted the export target");

      let bytes: Uint8Array;
      try {
        bytes = await applyMetadataPolicy(input, output.bytes, readMetadataText);
      } catch (error: unknown) {
        if (error instanceof ExportCancelledError) {
          return { status: "cancelled", phase: error.phase };
        }
        return { status: "failure", code: "encode-failed", phase: "encode" };
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
