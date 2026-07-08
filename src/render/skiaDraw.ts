import {
  FilterMode,
  MipmapMode,
  TextAlign,
  type SkCanvas,
  type SkImage,
  type SkParagraph,
  type SkTypefaceFontProvider,
} from "@shopify/react-native-skia";

import type { RenderScene, SceneImage, SceneText } from "./scene";

type SkiaApi = typeof import("@shopify/react-native-skia").Skia;

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
      return TextAlign.Left;
    case "center":
      return TextAlign.Center;
    case "right":
      return TextAlign.Right;
  }
}

export function makeSceneParagraph(
  api: SkiaApi,
  text: SceneText,
  fontProvider?: SkTypefaceFontProvider,
  resolveFontFamilies: FontFamilyResolver = systemFontFamilies,
): SkParagraph {
  const builder = api.ParagraphBuilder.Make(
    {
      textAlign: textAlign(text.alignment),
      textStyle: {
        backgroundColor:
          text.backgroundColor === null ? undefined : api.Color(text.backgroundColor),
        color: api.Color(text.color),
        fontFamilies: [...resolveFontFamilies(text.fontId)],
        fontSize: text.fontSize,
        heightMultiplier: text.lineHeight,
      },
    },
    fontProvider,
  );
  try {
    builder.addText(text.content);
    const paragraph = builder.build();
    paragraph.layout(text.width);
    return paragraph;
  } finally {
    builder.dispose();
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
      FilterMode.Linear,
      MipmapMode.None,
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
