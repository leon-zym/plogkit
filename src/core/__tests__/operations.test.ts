import { createDocument, type SourceImage, type TextElement } from "../document";
import {
  addTextElement,
  removeTextElement,
  reorderImages,
  setBackgroundColor,
  setCanvasRatio,
  setExportSettings,
  setStitchMode,
  setStitchSpacing,
  updateTextElement,
} from "../operations";

const images: readonly SourceImage[] = [
  {
    id: "image-1",
    originalUri: "file:///assets/image-1.jpg",
    previewUri: "file:///previews/image-1.jpg",
    width: 1200,
    height: 800,
  },
  {
    id: "image-2",
    originalUri: "file:///assets/image-2.jpg",
    previewUri: "file:///previews/image-2.jpg",
    width: 800,
    height: 1200,
  },
];

const text: TextElement = {
  id: "text-1",
  content: "周末的海边日记",
  position: { x: 24, y: 40 },
  width: 240,
  fontId: "system-sans",
  fontSize: 24,
  color: "#111111",
  alignment: "left",
  lineHeight: 1.4,
  backgroundColor: null,
};

describe("immutable document operations", () => {
  it("adds, updates, and removes text without mutating prior documents", () => {
    const initial = createDocument(images);
    const added = addTextElement(initial, text);
    const updated = updateTextElement(added, text.id, {
      content: "更新后的文字",
      position: { x: 80, y: 120 },
      alignment: "center",
    });
    const removed = removeTextElement(updated, text.id);

    expect(initial.textElements).toEqual([]);
    expect(added.textElements).toEqual([text]);
    expect(updated.textElements[0]).toMatchObject({
      content: "更新后的文字",
      position: { x: 80, y: 120 },
      alignment: "center",
    });
    expect(added.textElements[0]).toEqual(text);
    expect(removed.textElements).toEqual([]);
  });

  it("treats committing empty text as deletion", () => {
    const withText = addTextElement(createDocument(images), text);

    expect(updateTextElement(withText, text.id, { content: "" }).textElements).toEqual([]);
  });

  it("rejects duplicate or unknown text ids", () => {
    const withText = addTextElement(createDocument(images), text);

    expect(() => addTextElement(withText, text)).toThrow("already exists");
    expect(() => updateTextElement(withText, "missing", { content: "x" })).toThrow(
      "does not exist",
    );
    expect(() => removeTextElement(withText, "missing")).toThrow("does not exist");
  });

  it("updates canvas and stitch settings immutably", () => {
    const initial = createDocument(images);
    const updated = setStitchSpacing(
      setStitchMode(setCanvasRatio(setBackgroundColor(initial, "#112233"), "4:5"), "grid"),
      16,
    );

    expect(updated.canvas).toEqual({ ratio: "4:5", backgroundColor: "#112233" });
    expect(updated.stitch).toMatchObject({ mode: "grid", spacing: 16 });
    expect(initial).toEqual(createDocument(images));
  });

  it("updates export settings as one immutable document operation", () => {
    const initial = createDocument(images);
    const updated = setExportSettings(initial, {
      presetId: "compact",
      format: "png",
      metadataPolicy: "strip",
    });

    expect(updated.exportSettings).toEqual({
      presetId: "compact",
      format: "png",
      metadataPolicy: "strip",
    });
    expect(initial.exportSettings.presetId).toBe("original");
  });

  it("reorders images using an exact permutation", () => {
    const initial = createDocument(images);
    const reordered = reorderImages(initial, ["image-2", "image-1"]);

    expect(reordered.stitch.order).toEqual(["image-2", "image-1"]);
    expect(initial.stitch.order).toEqual(["image-1", "image-2"]);
    expect(() => reorderImages(initial, ["image-1", "image-1"])).toThrow("exact permutation");
    expect(() => reorderImages(initial, ["image-1"])).toThrow("exact permutation");
  });

  it("rejects invalid operation values", () => {
    const initial = createDocument(images);

    expect(() => setBackgroundColor(initial, "")).toThrow("background color");
    expect(() => setStitchSpacing(initial, -1)).toThrow("spacing");
    expect(() => addTextElement(initial, { ...text, content: "" })).toThrow("empty");
  });
});
