import {
  type FilterMode,
  type MipmapMode,
  type TextAlign,
  type SkCanvas,
  type SkImage,
  type SkParagraph,
  type SkTypefaceFontProvider,
} from "@shopify/react-native-skia";

import type { RenderScene, SceneImage, SceneText } from "./scene";

type SkiaApi = typeof import("@shopify/react-native-skia").Skia;

const FILTER_LINEAR = 1 as FilterMode;
const MIPMAP_NONE = 0 as MipmapMode;
const TEXT_ALIGN_LEFT = 0 as TextAlign;
const TEXT_ALIGN_RIGHT = 1 as TextAlign;
const TEXT_ALIGN_CENTER = 2 as TextAlign;

export type FontFamilyResolver = (fontId: string) => readonly string[];

export const systemFontFamilies: FontFamilyResolver = (fontId) => {
  if (fontId === "system-serif") {
    return ["serif"];
  }
  return ["system-ui", "PingFang SC", "sans-serif"];
};

function textAlign(alignment: SceneText["alignment"]): TextAlign {
  switch (alignment) {
    case "left":
      return TEXT_ALIGN_LEFT;
    case "center":
      return TEXT_ALIGN_CENTER;
    case "right":
      return TEXT_ALIGN_RIGHT;
  }
}

export function makeSceneParagraph(
  api: SkiaApi,
  text: SceneText,
  fontProvider?: SkTypefaceFontProvider,
  resolveFontFamilies: FontFamilyResolver = systemFontFamilies,
): SkParagraph {
  const resolvedFontProvider =
    fontProvider ?? (api.FontMgr.System() as SkTypefaceFontProvider);
  const builder = api.ParagraphBuilder.Make(
    {
      textAlign: textAlign(text.alignment),
      textStyle: {
        ...(text.backgroundColor === null
          ? {}
          : { backgroundColor: api.Color(text.backgroundColor) }),
        color: api.Color(text.color),
        fontFamilies: [...resolveFontFamilies(text.fontId)],
        fontSize: text.fontSize,
        heightMultiplier: text.lineHeight,
      },
    },
    resolvedFontProvider,
  );
  try {
    builder.addText(text.content);
    const paragraph = builder.build();
    paragraph.layout(text.width);
    return paragraph;
  } finally {
    builder.dispose?.();
  }
}

export function drawSceneBackground(api: SkiaApi, canvas: SkCanvas, scene: RenderScene): void {
  const paint = api.Paint();
  try {
    paint.setColor(api.Color(scene.backgroundColor));
    canvas.drawRect(api.XYWHRect(0, 0, scene.width, scene.height), paint);
  } finally {
    paint.dispose();
  }
}

export function drawSceneImage(
  api: SkiaApi,
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

export function drawSceneText(
  api: SkiaApi,
  canvas: SkCanvas,
  text: SceneText,
  fontProvider?: SkTypefaceFontProvider,
  resolveFontFamilies?: FontFamilyResolver,
): void {
  const paragraph = makeSceneParagraph(api, text, fontProvider, resolveFontFamilies);
  try {
    paragraph.paint(canvas, text.x, text.y);
  } finally {
    paragraph.dispose();
  }
}
