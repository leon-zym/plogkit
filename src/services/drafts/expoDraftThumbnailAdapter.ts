import { File } from "expo-file-system";
import { Skia, type SkImage } from "@shopify/react-native-skia";

import { createDeviceSkiaOffscreenSceneRenderer } from "@/render/deviceSkiaOffscreenRenderer";
import { documentToRenderScene } from "@/render/scene";
import type {
  SkiaOffscreenSceneRenderer,
  SkiaOffscreenTarget,
} from "@/render/skiaOffscreenRenderer";

import type {
  DraftThumbnailAdapter,
  DraftThumbnailProfile,
  DraftThumbnailSize,
} from "./draftLibrary";

type Representation = "square" | "original";
const SQUARE_TARGET_ID = "square";
const ORIGINAL_TARGET_ID = "original";

export interface DraftThumbnailGeometry extends DraftThumbnailSize {
  readonly scale: number;
  readonly translateX: number;
  readonly translateY: number;
}

export function calculateDraftThumbnailGeometry(
  sceneWidth: number,
  sceneHeight: number,
  profile: DraftThumbnailProfile,
  representation: Representation,
): DraftThumbnailGeometry {
  if (sceneWidth <= 0 || sceneHeight <= 0) {
    throw new Error("thumbnail scene dimensions must be positive");
  }
  const originalScale = Math.min(1, profile.originalLongEdge / Math.max(sceneWidth, sceneHeight));
  const size =
    representation === "square"
      ? { width: profile.squareSize, height: profile.squareSize }
      : {
          width: Math.max(1, Math.round(sceneWidth * originalScale)),
          height: Math.max(1, Math.round(sceneHeight * originalScale)),
        };
  const scale =
    representation === "square"
      ? Math.max(size.width / sceneWidth, size.height / sceneHeight)
      : Math.min(size.width / sceneWidth, size.height / sceneHeight);
  return {
    ...size,
    scale,
    translateX: (size.width - sceneWidth * scale) / 2,
    translateY: (size.height - sceneHeight * scale) / 2,
  };
}

async function loadImageForInspection(uri: string): Promise<SkImage | null> {
  const data = await Skia.Data.fromURI(uri);
  try {
    return Skia.Image.MakeImageFromEncoded(data);
  } finally {
    data.dispose();
  }
}

function createThumbnailTarget(
  sceneWidth: number,
  sceneHeight: number,
  profile: DraftThumbnailProfile,
  representation: Representation,
): SkiaOffscreenTarget {
  const geometry = calculateDraftThumbnailGeometry(
    sceneWidth,
    sceneHeight,
    profile,
    representation,
  );
  return {
    id: representation === "square" ? SQUARE_TARGET_ID : ORIGINAL_TARGET_ID,
    width: geometry.width,
    height: geometry.height,
    transform: {
      scaleX: geometry.scale,
      scaleY: geometry.scale,
      translateX: geometry.translateX,
      translateY: geometry.translateY,
    },
    encoding: { format: "jpeg", quality: profile.quality },
  };
}

function writeThumbnail(uri: string, bytes: Uint8Array): void {
  const file = new File(uri);
  file.create({ intermediates: true, overwrite: false });
  file.write(bytes);
}

export interface CreateExpoDraftThumbnailAdapterOptions {
  readonly renderer?: SkiaOffscreenSceneRenderer;
}

export function createExpoDraftThumbnailAdapter(
  options: CreateExpoDraftThumbnailAdapterOptions = {},
): DraftThumbnailAdapter {
  const renderer = options.renderer ?? createDeviceSkiaOffscreenSceneRenderer();
  return {
    generate: async (input) => {
      const scene = documentToRenderScene(input.document);
      const result = await renderer.render({
        scene,
        assets: input.assets,
        targets: [
          createThumbnailTarget(scene.width, scene.height, input.profile, "square"),
          createThumbnailTarget(scene.width, scene.height, input.profile, "original"),
        ],
      });
      if (result.status !== "rendered") {
        const detail =
          result.status === "cancelled"
            ? `cancelled during ${result.phase}`
            : `${result.code}: ${result.message}`;
        throw new Error(`thumbnail rendering failed: ${detail}`);
      }
      const square = result.outputs[SQUARE_TARGET_ID];
      const original = result.outputs[ORIGINAL_TARGET_ID];
      if (square === undefined || original === undefined) {
        throw new Error("Skia renderer omitted a requested thumbnail target");
      }
      writeThumbnail(input.squareUri, square.bytes);
      writeThumbnail(input.originalUri, original.bytes);
      return {
        square: { width: square.width, height: square.height },
        original: { width: original.width, height: original.height },
      };
    },
    inspect: async (uri) => {
      try {
        const file = new File(uri);
        if (!file.exists) return null;
        const image = await loadImageForInspection(uri);
        if (image === null) return null;
        try {
          return { width: image.width(), height: image.height() };
        } finally {
          image.dispose();
        }
      } catch {
        return null;
      }
    },
  };
}
