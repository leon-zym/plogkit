import { ImageFormat, Skia, type SkData, type SkImage } from "@shopify/react-native-skia";

import { getDeviceTextLayoutEnvironment } from "./deviceTextLayout";
import {
  createSkiaOffscreenSceneRenderer,
  type SkiaOffscreenEncoding,
  type SkiaOffscreenSceneRenderer,
  type SkiaOriginalAssetLoadResult,
} from "./skiaOffscreenRenderer";

async function loadOriginalAsset(uri: string): Promise<SkiaOriginalAssetLoadResult> {
  let data: SkData;
  try {
    data = await Skia.Data.fromURI(uri);
  } catch (error: unknown) {
    return {
      status: "failure",
      code: "load-failed",
      message: error instanceof Error ? error.message : `could not read original asset ${uri}`,
    };
  }

  try {
    let image: SkImage | null;
    try {
      image = Skia.Image.MakeImageFromEncoded(data);
    } catch (error: unknown) {
      return {
        status: "failure",
        code: "decode-failed",
        message: error instanceof Error ? error.message : `could not decode original asset ${uri}`,
      };
    }
    return image === null
      ? {
          status: "failure",
          code: "decode-failed",
          message: `could not decode original asset ${uri}`,
        }
      : { status: "ready", image };
  } finally {
    data.dispose();
  }
}

function encodeSnapshot(snapshot: SkImage, encoding: SkiaOffscreenEncoding): Uint8Array {
  return snapshot.encodeToBytes(
    encoding.format === "jpeg" ? ImageFormat.JPEG : ImageFormat.PNG,
    encoding.format === "jpeg" ? Math.round(encoding.quality * 100) : 100,
  );
}

export function createDeviceSkiaOffscreenSceneRenderer(): SkiaOffscreenSceneRenderer {
  return createSkiaOffscreenSceneRenderer({
    api: Skia,
    makeSurface: (width, height) => Skia.Surface.Make(width, height),
    loadOriginalAsset,
    getTextLayoutEnvironment: getDeviceTextLayoutEnvironment,
    encodeSnapshot,
  });
}
