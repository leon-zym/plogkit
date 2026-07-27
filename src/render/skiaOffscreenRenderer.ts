import {
  type FilterMode,
  type MipmapMode,
  type SkCanvas,
  type SkImage,
  type SkSurface,
} from "@shopify/react-native-skia";

import type { ImportedAssetId } from "../core/document";
import type { RenderScene, SceneImage } from "./scene";
import {
  createTextLayoutSnapshot,
  type AnyTextLayoutEnvironment,
  type TextLayout,
  type TextLayoutSnapshot,
} from "./textLayout";

type SkiaApi = typeof import("@shopify/react-native-skia").Skia;
type SkiaDrawApi = Pick<SkiaApi, "Color" | "Paint" | "XYWHRect">;

const FILTER_LINEAR = 1 as FilterMode;
const MIPMAP_NONE = 0 as MipmapMode;
const THUMBNAIL_BATCH_MAX_LONG_EDGE = 720;
const THUMBNAIL_BATCH_MAX_TOTAL_PIXELS = 648_000;

export interface SkiaOffscreenTransform {
  readonly scaleX: number;
  readonly scaleY: number;
  readonly translateX: number;
  readonly translateY: number;
}

export type SkiaOffscreenEncoding =
  { readonly format: "png" } | { readonly format: "jpeg"; readonly quality: number };

export interface SkiaOffscreenTarget {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly transform: SkiaOffscreenTransform;
  readonly encoding: SkiaOffscreenEncoding;
}

export type SkiaOffscreenTargets =
  readonly [SkiaOffscreenTarget] | readonly [SkiaOffscreenTarget, SkiaOffscreenTarget];

export interface SkiaOriginalAssetSource {
  readonly resolve: (
    assetId: ImportedAssetId,
    usage: "original",
  ) => { readonly uri: string } | null;
}

export interface SkiaOffscreenRenderInput {
  readonly scene: RenderScene;
  readonly assets: SkiaOriginalAssetSource;
  readonly targets: SkiaOffscreenTargets;
  readonly signal?: AbortSignal;
}

export interface SkiaOffscreenOutput {
  readonly targetId: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
}

export type SkiaOffscreenPhase = "assets" | "render" | "encode";

export type SkiaOffscreenFailure =
  | {
      readonly status: "failure";
      readonly code:
        | "original-asset-unavailable"
        | "original-asset-load-failed"
        | "original-asset-decode-failed";
      readonly phase: "assets";
      readonly assetId: ImportedAssetId;
      readonly message: string;
    }
  | {
      readonly status: "failure";
      readonly code: "target-invalid" | "text-layout-failed";
      readonly phase: "render";
      readonly message: string;
    }
  | {
      readonly status: "failure";
      readonly code: "surface-failed" | "draw-failed";
      readonly phase: "render";
      readonly targetId: string;
      readonly message: string;
    }
  | {
      readonly status: "failure";
      readonly code: "encode-failed";
      readonly phase: "encode";
      readonly targetId: string;
      readonly message: string;
    };

export type SkiaOffscreenRenderResult =
  | {
      readonly status: "rendered";
      readonly outputs: Readonly<Record<string, SkiaOffscreenOutput>>;
    }
  | {
      readonly status: "cancelled";
      readonly phase: SkiaOffscreenPhase;
    }
  | SkiaOffscreenFailure;

export interface SkiaOffscreenSceneRenderer {
  readonly render: (input: SkiaOffscreenRenderInput) => Promise<SkiaOffscreenRenderResult>;
}

export type SkiaOriginalAssetLoadResult =
  | { readonly status: "ready"; readonly image: SkImage }
  | {
      readonly status: "failure";
      readonly code: "load-failed" | "decode-failed";
      readonly message: string;
    };

export interface SkiaOffscreenRenderAdapter {
  readonly api: SkiaDrawApi;
  readonly makeSurface: (width: number, height: number) => SkSurface | null;
  readonly loadOriginalAsset: (uri: string) => Promise<SkiaOriginalAssetLoadResult>;
  readonly getTextLayoutEnvironment: () => AnyTextLayoutEnvironment;
  readonly encodeSnapshot: (snapshot: SkImage, encoding: SkiaOffscreenEncoding) => Uint8Array;
}

interface OwnedTarget {
  readonly target: SkiaOffscreenTarget;
  readonly surface: SkSurface;
  readonly canvas: SkCanvas;
}

function validateTarget(target: SkiaOffscreenTarget): string | null {
  if (target.id.length === 0) return "Skia offscreen target id must be non-empty";
  if (!Number.isInteger(target.width) || target.width <= 0) {
    return `Skia offscreen target ${target.id} width must be a positive integer`;
  }
  if (!Number.isInteger(target.height) || target.height <= 0) {
    return `Skia offscreen target ${target.id} height must be a positive integer`;
  }
  const { scaleX, scaleY, translateX, translateY } = target.transform;
  if (!Number.isFinite(scaleX) || scaleX <= 0 || !Number.isFinite(scaleY) || scaleY <= 0) {
    return `Skia offscreen target ${target.id} scale must be positive and finite`;
  }
  if (!Number.isFinite(translateX) || !Number.isFinite(translateY)) {
    return `Skia offscreen target ${target.id} translation must be finite`;
  }
  if (target.encoding.format === "jpeg") {
    if (
      !Number.isFinite(target.encoding.quality) ||
      target.encoding.quality < 0 ||
      target.encoding.quality > 1
    ) {
      return `Skia offscreen target ${target.id} JPEG quality must be between 0 and 1`;
    }
  } else if (target.encoding.format !== "png") {
    return `Skia offscreen target ${target.id} encoding is unsupported`;
  }
  return null;
}

function validateTargets(targets: readonly SkiaOffscreenTarget[]): string | null {
  if (targets.length < 1 || targets.length > 2) {
    return "Skia offscreen rendering requires one target or a two-target batch";
  }
  const ids = new Set<string>();
  for (const target of targets) {
    const targetError = validateTarget(target);
    if (targetError !== null) return targetError;
    if (ids.has(target.id)) {
      return `Skia offscreen target id ${target.id} must be unique`;
    }
    ids.add(target.id);
  }
  if (targets.length === 2) {
    if (
      targets.some(
        (target) =>
          Math.max(target.width, target.height) > THUMBNAIL_BATCH_MAX_LONG_EDGE,
      )
    ) {
      return `Skia offscreen two-target batch long edges must not exceed ${THUMBNAIL_BATCH_MAX_LONG_EDGE}px`;
    }
    const totalPixels = targets.reduce(
      (total, target) => total + target.width * target.height,
      0,
    );
    if (totalPixels > THUMBNAIL_BATCH_MAX_TOTAL_PIXELS) {
      return `Skia offscreen two-target batch must not exceed ${THUMBNAIL_BATCH_MAX_TOTAL_PIXELS} total output pixels`;
    }
  }
  return null;
}

function cancelled(
  signal: AbortSignal | undefined,
  phase: SkiaOffscreenPhase,
): SkiaOffscreenRenderResult | null {
  return signal?.aborted === true ? { status: "cancelled", phase } : null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function drawSceneBackground(api: SkiaDrawApi, canvas: SkCanvas, scene: RenderScene): void {
  const paint = api.Paint();
  try {
    paint.setColor(api.Color(scene.backgroundColor));
    canvas.drawRect(api.XYWHRect(0, 0, scene.width, scene.height), paint);
  } finally {
    paint.dispose();
  }
}

function drawSceneImage(
  api: SkiaDrawApi,
  canvas: SkCanvas,
  node: SceneImage,
  image: SkImage,
): void {
  const paint = api.Paint();
  try {
    paint.setAntiAlias(true);
    canvas.drawImageRectOptions(
      image,
      api.XYWHRect(0, 0, image.width(), image.height()),
      api.XYWHRect(
        node.destination.x,
        node.destination.y,
        node.destination.width,
        node.destination.height,
      ),
      FILTER_LINEAR,
      MIPMAP_NONE,
      paint,
    );
  } finally {
    paint.dispose();
  }
}

function drawTextLayout(canvas: SkCanvas, layout: TextLayout): void {
  layout.paragraph.paint(canvas, layout.placement.x, layout.placement.y);
}

function disposeSurfaces(targets: readonly OwnedTarget[]): void {
  let firstError: unknown;
  for (const { surface } of [...targets].reverse()) {
    try {
      surface.dispose();
    } catch (error: unknown) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

function disposeOwnedResources(
  textLayout: TextLayoutSnapshot | null,
  targets: readonly OwnedTarget[],
): void {
  let firstError: unknown;
  try {
    textLayout?.dispose();
  } catch (error: unknown) {
    firstError = error;
  }
  try {
    disposeSurfaces(targets);
  } catch (error: unknown) {
    firstError ??= error;
  }
  if (firstError !== undefined) throw firstError;
}

export function createSkiaOffscreenSceneRenderer(
  adapter: SkiaOffscreenRenderAdapter,
): SkiaOffscreenSceneRenderer {
  const render = async (input: SkiaOffscreenRenderInput): Promise<SkiaOffscreenRenderResult> => {
    const validationError = validateTargets(input.targets);
    if (validationError !== null) {
      return {
        status: "failure",
        code: "target-invalid",
        phase: "render",
        message: validationError,
      };
    }
    const beforeStart = cancelled(input.signal, "assets");
    if (beforeStart !== null) return beforeStart;

    const ownedTargets: OwnedTarget[] = [];
    let textLayout: TextLayoutSnapshot | null = null;
    try {
      const textLayoutResult = createTextLayoutSnapshot(
        adapter.getTextLayoutEnvironment(),
        input.scene.texts,
      );
      if (textLayoutResult.status === "failure") {
        return {
          status: "failure",
          code: "text-layout-failed",
          phase: "render",
          message: textLayoutResult.message,
        };
      }
      textLayout = textLayoutResult.snapshot;

      const beforeSurfaces = cancelled(input.signal, "render");
      if (beforeSurfaces !== null) return beforeSurfaces;
      for (const target of input.targets) {
        let surface: SkSurface | null;
        try {
          surface = adapter.makeSurface(target.width, target.height);
        } catch (error: unknown) {
          return {
            status: "failure",
            code: "surface-failed",
            phase: "render",
            targetId: target.id,
            message: errorMessage(error, "Skia surface creation failed"),
          };
        }
        if (surface === null) {
          return {
            status: "failure",
            code: "surface-failed",
            phase: "render",
            targetId: target.id,
            message: `could not create ${target.width}x${target.height} Skia surface`,
          };
        }

        let canvas: SkCanvas;
        try {
          canvas = surface.getCanvas();
          canvas.translate(target.transform.translateX, target.transform.translateY);
          canvas.scale(target.transform.scaleX, target.transform.scaleY);
          drawSceneBackground(adapter.api, canvas, input.scene);
        } catch (error: unknown) {
          surface.dispose();
          return {
            status: "failure",
            code: "draw-failed",
            phase: "render",
            targetId: target.id,
            message: errorMessage(error, "Skia background drawing failed"),
          };
        }
        ownedTargets.push({ target, surface, canvas });
      }

      const afterBackground = cancelled(input.signal, "render");
      if (afterBackground !== null) return afterBackground;
      for (const node of input.scene.images) {
        const beforeAsset = cancelled(input.signal, "assets");
        if (beforeAsset !== null) return beforeAsset;
        const descriptor = input.assets.resolve(node.imageId, "original");
        if (descriptor === null) {
          return {
            status: "failure",
            code: "original-asset-unavailable",
            phase: "assets",
            assetId: node.imageId,
            message: `original asset ${node.imageId} is unavailable`,
          };
        }

        const loaded = await adapter.loadOriginalAsset(descriptor.uri);
        if (loaded.status === "failure") {
          return {
            status: "failure",
            code:
              loaded.code === "load-failed"
                ? "original-asset-load-failed"
                : "original-asset-decode-failed",
            phase: "assets",
            assetId: node.imageId,
            message: loaded.message,
          };
        }
        try {
          const afterLoad = cancelled(input.signal, "assets");
          if (afterLoad !== null) return afterLoad;
          for (const owned of ownedTargets) {
            try {
              drawSceneImage(adapter.api, owned.canvas, node, loaded.image);
            } catch (error: unknown) {
              return {
                status: "failure",
                code: "draw-failed",
                phase: "render",
                targetId: owned.target.id,
                message: errorMessage(error, `could not draw original asset ${node.imageId}`),
              };
            }
          }
          const afterDraw = cancelled(input.signal, "render");
          if (afterDraw !== null) return afterDraw;
        } finally {
          loaded.image.dispose();
        }
      }

      for (const owned of ownedTargets) {
        try {
          for (const layout of textLayout.layouts) {
            drawTextLayout(owned.canvas, layout);
          }
        } catch (error: unknown) {
          return {
            status: "failure",
            code: "draw-failed",
            phase: "render",
            targetId: owned.target.id,
            message: errorMessage(error, "Skia text drawing failed"),
          };
        }
      }

      const afterText = cancelled(input.signal, "render");
      if (afterText !== null) return afterText;
      const outputs: Record<string, SkiaOffscreenOutput> = Object.create(null) as Record<
        string,
        SkiaOffscreenOutput
      >;
      for (const owned of ownedTargets) {
        let snapshot: SkImage | null = null;
        try {
          try {
            owned.surface.flush();
            snapshot = owned.surface.makeImageSnapshot();
          } catch (error: unknown) {
            return {
              status: "failure",
              code: "surface-failed",
              phase: "render",
              targetId: owned.target.id,
              message: errorMessage(error, "Skia snapshot creation failed"),
            };
          }

          const afterSnapshot = cancelled(input.signal, "render");
          if (afterSnapshot !== null) return afterSnapshot;
          const beforeEncode = cancelled(input.signal, "encode");
          if (beforeEncode !== null) return beforeEncode;
          let bytes: Uint8Array;
          try {
            bytes = adapter.encodeSnapshot(snapshot, owned.target.encoding);
          } catch (error: unknown) {
            return {
              status: "failure",
              code: "encode-failed",
              phase: "encode",
              targetId: owned.target.id,
              message: errorMessage(error, "Skia image encoding failed"),
            };
          }
          if (bytes.length === 0) {
            return {
              status: "failure",
              code: "encode-failed",
              phase: "encode",
              targetId: owned.target.id,
              message: "Skia produced an empty encoded image",
            };
          }
          const afterEncode = cancelled(input.signal, "encode");
          if (afterEncode !== null) return afterEncode;
          outputs[owned.target.id] = Object.freeze({
            targetId: owned.target.id,
            width: owned.target.width,
            height: owned.target.height,
            bytes,
          });
        } finally {
          snapshot?.dispose();
        }
      }
      return { status: "rendered", outputs: Object.freeze(outputs) };
    } finally {
      disposeOwnedResources(textLayout, ownedTargets);
    }
  };

  return Object.freeze({ render });
}
