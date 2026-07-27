import {
  getSkiaExports,
  ImageFormat,
  makeOffscreenSurface,
  type SkImage,
} from "@shopify/react-native-skia/lib/commonjs/headless";

import {
  createSkiaOffscreenSceneRenderer,
  type SkiaOffscreenEncoding,
  type SkiaOffscreenSceneRenderer,
  type SkiaOriginalAssetLoadResult,
} from "./skiaOffscreenRenderer";
import {
  createUnavailableTextLayoutEnvironment,
  type AnyTextLayoutEnvironment,
} from "./textLayout";

export function createHeadlessSkiaOffscreenSceneRenderer(
  encodedAssets: ReadonlyMap<string, Uint8Array>,
  textLayoutEnvironment: AnyTextLayoutEnvironment = createUnavailableTextLayoutEnvironment(
    "headless text rendering requires a bundled-font layout environment",
  ),
): SkiaOffscreenSceneRenderer {
  const { Skia } = getSkiaExports();

  const loadOriginalAsset = async (uri: string): Promise<SkiaOriginalAssetLoadResult> => {
    const encoded = encodedAssets.get(uri);
    if (encoded === undefined) {
      return {
        status: "failure",
        code: "load-failed",
        message: `headless fixture ${uri} is unavailable`,
      };
    }
    let data;
    try {
      data = Skia.Data.fromBytes(encoded);
    } catch (error: unknown) {
      return {
        status: "failure",
        code: "load-failed",
        message: error instanceof Error ? error.message : `could not read headless fixture ${uri}`,
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
          message:
            error instanceof Error ? error.message : `could not decode headless fixture ${uri}`,
        };
      }
      return image === null
        ? {
            status: "failure",
            code: "decode-failed",
            message: `could not decode headless fixture ${uri}`,
          }
        : { status: "ready", image };
    } finally {
      data.dispose();
    }
  };

  const encodeSnapshot = (snapshot: SkImage, encoding: SkiaOffscreenEncoding): Uint8Array =>
    snapshot.encodeToBytes(
      encoding.format === "jpeg" ? ImageFormat.JPEG : ImageFormat.PNG,
      encoding.format === "jpeg" ? Math.round(encoding.quality * 100) : 100,
    );

  return createSkiaOffscreenSceneRenderer({
    api: Skia as unknown as typeof import("@shopify/react-native-skia").Skia,
    makeSurface: makeOffscreenSurface,
    loadOriginalAsset,
    getTextLayoutEnvironment: () => textLayoutEnvironment,
    encodeSnapshot,
  });
}
