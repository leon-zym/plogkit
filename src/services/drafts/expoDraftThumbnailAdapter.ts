import { File } from "expo-file-system";
import {
  ImageFormat,
  Skia,
  type SkImage,
  type SkSurface,
} from "@shopify/react-native-skia";

import { getDeviceTextLayoutEnvironment } from "@/render/deviceTextLayout";
import { documentToRenderScene, type RenderScene } from "@/render/scene";
import { drawSceneBackground, drawSceneImage, drawTextLayout } from "@/render/skiaDraw";
import { createTextLayoutSnapshot } from "@/render/textLayout";

import type {
  AssetCatalogSnapshot,
  DraftThumbnailAdapter,
  DraftThumbnailProfile,
  DraftThumbnailSize,
} from "./draftLibrary";

type Representation = "square" | "original";

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
  const originalScale = Math.min(
    1,
    profile.originalLongEdge / Math.max(sceneWidth, sceneHeight),
  );
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

async function loadImage(uri: string): Promise<SkImage | null> {
  const data = await Skia.Data.fromURI(uri);
  try {
    return Skia.Image.MakeImageFromEncoded(data);
  } finally {
    data.dispose();
  }
}

async function renderRepresentation(
  scene: RenderScene,
  assets: AssetCatalogSnapshot,
  profile: DraftThumbnailProfile,
  representation: Representation,
  destinationUri: string,
): Promise<DraftThumbnailSize> {
  const geometry = calculateDraftThumbnailGeometry(
    scene.width,
    scene.height,
    profile,
    representation,
  );
  let surface: SkSurface | null = null;
  let snapshot: SkImage | null = null;
  const textLayoutResult = createTextLayoutSnapshot(
    getDeviceTextLayoutEnvironment(),
    scene.texts,
  );
  if (textLayoutResult.status === "failure") {
    throw new Error(`thumbnail text layout failed: ${textLayoutResult.message}`);
  }
  const textLayout = textLayoutResult.snapshot;
  try {
    surface = Skia.Surface.Make(geometry.width, geometry.height);
    if (surface === null) throw new Error("could not create thumbnail surface");
    const canvas = surface.getCanvas();
    canvas.translate(geometry.translateX, geometry.translateY);
    canvas.scale(geometry.scale, geometry.scale);
    drawSceneBackground(Skia, canvas, scene);
    for (const node of scene.images) {
      const descriptor = assets.resolve(node.imageId, "original");
      if (descriptor === null) throw new Error(`thumbnail asset ${node.imageId} is unavailable`);
      const image = await loadImage(descriptor.uri);
      if (image === null) throw new Error(`thumbnail asset ${node.imageId} could not decode`);
      try {
        drawSceneImage(Skia, canvas, node, image);
      } finally {
        image.dispose();
      }
    }
    for (const layout of textLayout.layouts) drawTextLayout(canvas, layout);
    surface.flush();
    snapshot = surface.makeImageSnapshot();
    const bytes = snapshot.encodeToBytes(ImageFormat.JPEG, Math.round(profile.quality * 100));
    if (bytes.length === 0) throw new Error("Skia produced an empty thumbnail");
    const file = new File(destinationUri);
    file.create({ intermediates: true, overwrite: false });
    file.write(bytes);
    return { width: geometry.width, height: geometry.height };
  } finally {
    snapshot?.dispose();
    textLayout.dispose();
    surface?.dispose();
  }
}

export function createExpoDraftThumbnailAdapter(): DraftThumbnailAdapter {
  return {
    generate: async (input) => {
      const scene = documentToRenderScene(input.document);
      const square = await renderRepresentation(
        scene,
        input.assets,
        input.profile,
        "square",
        input.squareUri,
      );
      const original = await renderRepresentation(
        scene,
        input.assets,
        input.profile,
        "original",
        input.originalUri,
      );
      return { square, original };
    },
    inspect: async (uri) => {
      try {
        const file = new File(uri);
        if (!file.exists) return null;
        const image = await loadImage(uri);
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
