import {
  type SkParagraph,
  type SkTypefaceFontProvider,
  type TextAlign,
} from "@shopify/react-native-skia";

import type { Point } from "../core/document";
import type { SceneText } from "./scene";
import type { TextLayoutGeometry } from "./textLayoutGeometry";

type SkiaApi = typeof import("@shopify/react-native-skia").Skia;

const TEXT_ALIGN_LEFT = 0 as TextAlign;
const TEXT_ALIGN_RIGHT = 1 as TextAlign;
const TEXT_ALIGN_CENTER = 2 as TextAlign;

export interface TextLayoutEnvironmentOptions {
  readonly api: Pick<SkiaApi, "Color" | "ParagraphBuilder">;
  readonly fontProvider: SkTypefaceFontProvider;
  readonly fontFamilies: Readonly<Record<string, readonly string[]>>;
}

export interface TextLayoutEnvironment extends TextLayoutEnvironmentOptions {
  readonly status: "ready";
}

export interface UnavailableTextLayoutEnvironment {
  readonly status: "unavailable";
  readonly reason: string;
}

export type AnyTextLayoutEnvironment = TextLayoutEnvironment | UnavailableTextLayoutEnvironment;

export interface TextLayout {
  readonly id: string;
  readonly paragraph: SkParagraph;
  readonly placement: Point;
}

export interface TextLayoutSnapshot {
  readonly layouts: readonly TextLayout[];
  readonly geometry: readonly TextLayoutGeometry[];
  dispose(): void;
}

export interface EnvironmentUnavailableTextLayoutFailure {
  readonly status: "failure";
  readonly code: "environment-unavailable";
  readonly message: string;
}

export interface TextBlockLayoutFailure {
  readonly status: "failure";
  readonly code: "font-unavailable" | "layout-failed";
  readonly message: string;
  readonly textId: string;
  readonly fontId?: string;
}

export type TextLayoutFailure = EnvironmentUnavailableTextLayoutFailure | TextBlockLayoutFailure;

export type TextLayoutSnapshotResult =
  { readonly status: "ready"; readonly snapshot: TextLayoutSnapshot } | TextLayoutFailure;

export function createTextLayoutEnvironment(
  options: TextLayoutEnvironmentOptions,
): TextLayoutEnvironment {
  const fontFamilies = Object.freeze(
    Object.fromEntries(
      Object.entries(options.fontFamilies).map(([id, families]) => [
        id,
        Object.freeze([...families]),
      ]),
    ),
  );
  return Object.freeze({ ...options, fontFamilies, status: "ready" as const });
}

export function createUnavailableTextLayoutEnvironment(
  reason: string,
): UnavailableTextLayoutEnvironment {
  return Object.freeze({ status: "unavailable" as const, reason });
}

function resolveTextAlign(alignment: SceneText["alignment"]): TextAlign {
  switch (alignment) {
    case "left":
      return TEXT_ALIGN_LEFT;
    case "center":
      return TEXT_ALIGN_CENTER;
    case "right":
      return TEXT_ALIGN_RIGHT;
  }
}

function createParagraph(
  environment: TextLayoutEnvironment,
  text: SceneText,
  fontFamilies: readonly string[],
): SkParagraph {
  const builder = environment.api.ParagraphBuilder.Make(
    {
      textAlign: resolveTextAlign(text.alignment),
    },
    environment.fontProvider,
  );
  try {
    builder.pushStyle({
      ...(text.backgroundColor === null
        ? {}
        : { backgroundColor: environment.api.Color(text.backgroundColor) }),
      color: environment.api.Color(text.color),
      fontFamilies: [...fontFamilies],
      fontSize: text.fontSize,
      heightMultiplier: text.lineHeight,
    });
    try {
      builder.addText(text.content);
    } finally {
      builder.pop();
    }
    const paragraph = builder.build();
    try {
      paragraph.layout(text.width);
      return paragraph;
    } catch (error: unknown) {
      paragraph.dispose();
      throw error;
    }
  } finally {
    builder.dispose?.();
  }
}

function createGeometry(text: SceneText, paragraph: SkParagraph): TextLayoutGeometry {
  const lines = paragraph.getLineMetrics();
  const left = lines.length === 0 ? 0 : Math.min(...lines.map((line) => line.left));
  const right = lines.length === 0 ? 0 : Math.max(...lines.map((line) => line.left + line.width));
  const paragraphHeight = paragraph.getHeight();
  const top =
    lines.length === 0
      ? 0
      : Math.min(0, ...lines.map((line) => line.baseline - line.ascent));
  const bottom =
    lines.length === 0
      ? paragraphHeight
      : Math.max(paragraphHeight, ...lines.map((line) => line.baseline + line.descent));
  return Object.freeze({
    id: text.id,
    placement: Object.freeze({ x: text.x, y: text.y }),
    localVisualBounds: Object.freeze({
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    }),
  });
}

class OwnedTextLayoutSnapshot implements TextLayoutSnapshot {
  private readonly ownedLayouts: readonly TextLayout[];
  private readonly ownedGeometry: readonly TextLayoutGeometry[];
  private disposed = false;

  constructor(layouts: readonly TextLayout[], geometry: readonly TextLayoutGeometry[]) {
    this.ownedLayouts = Object.freeze([...layouts]);
    this.ownedGeometry = Object.freeze([...geometry]);
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("text layout snapshot has been disposed");
  }

  get layouts(): readonly TextLayout[] {
    this.assertAlive();
    return this.ownedLayouts;
  }

  get geometry(): readonly TextLayoutGeometry[] {
    this.assertAlive();
    return this.ownedGeometry;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const layout of this.ownedLayouts) layout.paragraph.dispose();
  }
}

export function createTextLayoutSnapshot(
  environment: AnyTextLayoutEnvironment,
  texts: readonly SceneText[],
): TextLayoutSnapshotResult {
  if (texts.length === 0) {
    return {
      status: "ready",
      snapshot: new OwnedTextLayoutSnapshot([], []),
    };
  }
  if (environment.status === "unavailable") {
    return {
      status: "failure",
      code: "environment-unavailable",
      message: environment.reason,
    };
  }

  const layouts: TextLayout[] = [];
  const geometry: TextLayoutGeometry[] = [];

  for (const text of texts) {
    const families = environment.fontFamilies[text.fontId];
    if (families === undefined || families.length === 0) {
      for (const layout of layouts) layout.paragraph.dispose();
      return {
        status: "failure",
        code: "font-unavailable",
        message: `font ${text.fontId} is unavailable in the text layout environment`,
        textId: text.id,
        fontId: text.fontId,
      };
    }

    let paragraph: SkParagraph | null = null;
    try {
      paragraph = createParagraph(environment, text, families);
      layouts.push(
        Object.freeze({
          id: text.id,
          paragraph,
          placement: Object.freeze({ x: text.x, y: text.y }),
        }),
      );
      geometry.push(createGeometry(text, paragraph));
    } catch (error: unknown) {
      if (paragraph !== null && !layouts.some((layout) => layout.paragraph === paragraph)) {
        paragraph.dispose();
      }
      for (const layout of layouts) layout.paragraph.dispose();
      return {
        status: "failure",
        code: "layout-failed",
        message: error instanceof Error ? error.message : "text layout failed",
        textId: text.id,
      };
    }
  }

  return {
    status: "ready",
    snapshot: new OwnedTextLayoutSnapshot(layouts, geometry),
  };
}
