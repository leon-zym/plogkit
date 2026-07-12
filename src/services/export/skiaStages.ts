import { ImageFormat, Skia, type SkImage } from "@shopify/react-native-skia";

import { documentToRenderScene } from "../../render/scene";
import { drawSceneBackground, drawSceneImage, drawSceneText } from "../../render/skiaDraw";
import type { ExportPlan } from "./plan";
import type { ExportRenderStage, RenderedPixels } from "./types";

class SkiaRenderedPixels implements RenderedPixels {
  readonly width: number;
  readonly height: number;
  private readonly image: SkImage;
  private disposed = false;

  constructor(image: SkImage) {
    this.image = image;
    this.width = image.width();
    this.height = image.height();
  }

  encode(format: ExportPlan["format"], quality: number): Uint8Array {
    if (this.disposed) {
      throw new Error("rendered pixels have already been disposed");
    }
    const imageFormat = format === "jpeg" ? ImageFormat.JPEG : ImageFormat.PNG;
    return this.image.encodeToBytes(imageFormat, Math.round(quality * 100));
  }

  dispose(): void {
    if (!this.disposed) {
      this.image.dispose();
      this.disposed = true;
    }
  }
}

export class SkiaExportRenderStage implements ExportRenderStage {
  async render(document: Parameters<ExportRenderStage["render"]>[0], plan: ExportPlan) {
    const scene = documentToRenderScene(document, "original");
    const surface = Skia.Surface.Make(plan.width, plan.height);
    if (surface === null) {
      throw new Error(`could not create ${plan.width}x${plan.height} CPU export surface`);
    }

    let snapshot: SkImage | null = null;
    try {
      const canvas = surface.getCanvas();
      canvas.scale(plan.width / scene.width, plan.height / scene.height);
      drawSceneBackground(Skia, canvas, scene);

      for (const node of scene.images) {
        const data = await Skia.Data.fromURI(node.uri);
        let image: SkImage | null = null;
        try {
          image = Skia.Image.MakeImageFromEncoded(data);
        } finally {
          data.dispose();
        }
        if (image === null) {
          throw new Error(`could not decode original image ${node.imageId}`);
        }
        try {
          drawSceneImage(Skia, canvas, node, image);
          surface.flush();
        } finally {
          image.dispose();
        }
      }

      for (const text of scene.texts) {
        drawSceneText(Skia, canvas, text);
      }
      surface.flush();
      snapshot = surface.makeImageSnapshot();
      return new SkiaRenderedPixels(snapshot);
    } catch (error: unknown) {
      snapshot?.dispose();
      throw error;
    } finally {
      surface.dispose();
    }
  }
}
