import { createDocument, type PlogDocument, type SourceImage } from "../../core/document";
import {
  documentToRenderScene,
  getNaturalSceneSize,
  LOGICAL_CANVAS_WIDTH,
} from "../scene";

const images: readonly SourceImage[] = [
  {
    id: "wide",
    originalUri: "file:///wide-original.jpg",
    previewUri: "file:///wide-preview.jpg",
    width: 4000,
    height: 3000,
  },
  {
    id: "tall",
    originalUri: "file:///tall-original.jpg",
    previewUri: "file:///tall-preview.jpg",
    width: 2000,
    height: 4000,
  },
];

function updateDocument(
  update: Partial<Pick<PlogDocument, "canvas" | "stitch" | "textElements">>,
): PlogDocument {
  return { ...createDocument(images), ...update };
}

describe("document render scene", () => {
  it("uses a 1000-unit logical canvas and preview images for device rendering", () => {
    const scene = documentToRenderScene(createDocument([images[0]!]));

    expect(scene).toMatchObject({
      width: LOGICAL_CANVAS_WIDTH,
      height: 750,
      backgroundColor: "#FFFFFF",
    });
    expect(scene.images[0]).toMatchObject({
      imageId: "wide",
      uri: "file:///wide-preview.jpg",
      destination: { x: 0, y: 0, width: 1000, height: 750 },
    });
  });

  it.each([
    ["1:1", 1000],
    ["3:4", 4000 / 3],
    ["4:5", 1250],
    ["9:16", 16000 / 9],
  ] as const)("places an original-aspect image with contain on a %s canvas", (ratio, height) => {
    const base = createDocument([images[0]!]);
    const document: PlogDocument = {
      ...base,
      canvas: { ratio, backgroundColor: "#112233" },
    };
    const scene = documentToRenderScene(document);

    expect(scene.height).toBeCloseTo(height);
    expect(scene.images[0]?.destination).toMatchObject({
      x: 0,
      width: 1000,
      height: 750,
    });
    expect(scene.images[0]?.destination.y).toBeCloseTo((height - 750) / 2);
  });

  it("reuses core vertical layout and preserves image order and spacing", () => {
    const document = updateDocument({
      stitch: { mode: "vertical", spacing: 20, order: ["tall", "wide"] },
    });
    const scene = documentToRenderScene(document, "original");

    expect(scene.height).toBe(2770);
    expect(scene.images.map(({ imageId, uri, destination }) => ({ imageId, uri, destination }))).toEqual([
      {
        imageId: "tall",
        uri: "file:///tall-original.jpg",
        destination: { x: 0, y: 0, width: 1000, height: 2000 },
      },
      {
        imageId: "wide",
        uri: "file:///wide-original.jpg",
        destination: { x: 0, y: 2020, width: 1000, height: 750 },
      },
    ]);
  });

  it("uses equal two-column cells and contains each grid image", () => {
    const document = updateDocument({
      stitch: { mode: "grid", spacing: 20, order: ["wide", "tall"] },
    });
    const scene = documentToRenderScene(document);

    expect(scene.height).toBe(490);
    expect(scene.images.map(({ destination }) => destination)).toEqual([
      { x: 0, y: 61.25, width: 490, height: 367.5 },
      { x: 632.5, y: 0, width: 245, height: 490 },
    ]);
  });

  it("keeps text in logical coordinates for scaled Paragraph rendering", () => {
    const document = updateDocument({
      textElements: [
        {
          id: "caption",
          content: "这是超过一百字时也会在 Paragraph 宽度内自动换行的中文说明。",
          position: { x: 120, y: 240 },
          width: 640,
          fontId: "system-sans",
          fontSize: 42,
          color: "#101010",
          alignment: "center",
          lineHeight: 1.4,
          backgroundColor: "#FFFFFFCC",
        },
      ],
    });
    const scene = documentToRenderScene(document);

    expect(scene.texts).toEqual([
      {
        id: "caption",
        content: "这是超过一百字时也会在 Paragraph 宽度内自动换行的中文说明。",
        x: 120,
        y: 240,
        width: 640,
        fontId: "system-sans",
        fontSize: 42,
        color: "#101010",
        alignment: "center",
        lineHeight: 1.4,
        backgroundColor: "#FFFFFFCC",
      },
    ]);
  });

  it("derives original export resolution from source pixels, not preview pixels", () => {
    const scene = documentToRenderScene(createDocument([images[0]!]));

    expect(getNaturalSceneSize(scene)).toEqual({ width: 4000, height: 3000 });
  });
});
