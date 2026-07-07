import {
  isExactImageOrder,
  parseDocument,
  type CanvasRatio,
  type PlogDocument,
  type Point,
  type StitchMode,
  type TextAlignment,
  type TextElement,
} from "./document";

export type TextElementUpdate = Partial<{
  content: string;
  position: Point;
  width: number;
  fontId: string;
  fontSize: number;
  color: string;
  alignment: TextAlignment;
  lineHeight: number;
  backgroundColor: string | null;
}>;

function requireTextIndex(document: PlogDocument, id: string): number {
  const index = document.textElements.findIndex((element) => element.id === id);
  if (index === -1) {
    throw new Error(`text element ${id} does not exist`);
  }
  return index;
}

export function addTextElement(document: PlogDocument, element: TextElement): PlogDocument {
  if (element.content.length === 0) {
    throw new Error("cannot add an empty text element");
  }
  if (document.textElements.some(({ id }) => id === element.id)) {
    throw new Error(`text element ${element.id} already exists`);
  }
  return parseDocument({
    ...document,
    textElements: [...document.textElements, element],
  });
}

export function updateTextElement(
  document: PlogDocument,
  id: string,
  update: TextElementUpdate,
): PlogDocument {
  const index = requireTextIndex(document, id);
  if (update.content === "") {
    return removeTextElement(document, id);
  }
  const textElements = document.textElements.map((element, elementIndex) =>
    elementIndex === index ? { ...element, ...update } : element,
  );
  return parseDocument({ ...document, textElements });
}

export function removeTextElement(document: PlogDocument, id: string): PlogDocument {
  const index = requireTextIndex(document, id);
  return parseDocument({
    ...document,
    textElements: document.textElements.filter((_, elementIndex) => elementIndex !== index),
  });
}

export function setBackgroundColor(document: PlogDocument, backgroundColor: string): PlogDocument {
  if (backgroundColor.length === 0) {
    throw new Error("background color must not be empty");
  }
  return parseDocument({
    ...document,
    canvas: { ...document.canvas, backgroundColor },
  });
}

export function setCanvasRatio(document: PlogDocument, ratio: CanvasRatio): PlogDocument {
  return parseDocument({
    ...document,
    canvas: { ...document.canvas, ratio },
  });
}

export function setStitchMode(document: PlogDocument, mode: StitchMode): PlogDocument {
  return parseDocument({
    ...document,
    stitch: { ...document.stitch, mode },
  });
}

export function setStitchSpacing(document: PlogDocument, spacing: number): PlogDocument {
  if (!Number.isFinite(spacing) || spacing < 0) {
    throw new Error("stitch spacing must be a non-negative finite number");
  }
  return parseDocument({
    ...document,
    stitch: { ...document.stitch, spacing },
  });
}

export function reorderImages(document: PlogDocument, order: readonly string[]): PlogDocument {
  const imageIds = document.sourceImages.map(({ id }) => id);
  if (!isExactImageOrder(order, imageIds)) {
    throw new Error("image order must be an exact permutation of source image ids");
  }
  return parseDocument({
    ...document,
    stitch: { ...document.stitch, order },
  });
}
