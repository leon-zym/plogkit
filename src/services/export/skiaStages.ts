import { ImageFormat, Skia, type SkImage, type SkSurface } from "@shopify/react-native-skia";

import { getDeviceTextLayoutEnvironment } from "../../render/deviceTextLayout";
import { documentToRenderScene } from "../../render/scene";
import { drawSceneBackground, drawSceneImage, drawTextLayout } from "../../render/skiaDraw";
import { createTextLayoutSnapshot } from "../../render/textLayout";
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
    const textLayoutResult = createTextLayoutSnapshot(
      getDeviceTextLayoutEnvironment(),
      scene.texts,
    );
    if (textLayoutResult.status === "failure") {
      throw new Error(`export text layout failed: ${textLayoutResult.message}`);
    }
    const textLayout = textLayoutResult.snapshot;
    let surface: SkSurface | null;
    try {
      surface = Skia.Surface.Make(plan.width, plan.height);
    } catch (error: unknown) {
      textLayout.dispose();
      throw error;
    }
    if (surface === null) {
      textLayout.dispose();
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

      for (const layout of textLayout.layouts) {
        drawTextLayout(canvas, layout);
      }
      surface.flush();
      snapshot = surface.makeImageSnapshot();
      return new SkiaRenderedPixels(snapshot);
    } catch (error: unknown) {
      snapshot?.dispose();
      throw error;
    } finally {
      textLayout.dispose();
      surface.dispose();
    }
  }
}
