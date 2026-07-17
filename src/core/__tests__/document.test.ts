import {
  createDocument,
  createEmptyDocument,
  DOCUMENT_SCHEMA_VERSION,
  DocumentParseError,
  migrateDocument,
  parseDocument,
  parseDocumentJson,
  type SourceImage,
} from "../document";

const image: SourceImage = {
  id: "image-1",
  originalUri: "file:///projects/current/assets/image-1.jpg",
  previewUri: "file:///projects/current/previews/image-1.jpg",
  width: 4032,
  height: 3024,
};

const textElement = {
  id: "text-1",
  content: "hello",
  position: { x: 0, y: 0 },
  width: 240,
  fontId: "system-sans",
  fontSize: 24,
  color: "#000000",
  alignment: "left",
  lineHeight: 1.4,
  backgroundColor: null,
} as const;

describe("document model", () => {
  it("creates the complete document with stable defaults", () => {
    const doc = createEmptyDocument();

    expect(doc).toEqual({
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      sourceImages: [],
      canvas: {
        ratio: "original",
        backgroundColor: "#FFFFFF",
      },
      stitch: {
        mode: "vertical",
        spacing: 0,
        order: [],
      },
      textElements: [],
      exportSettings: {
        presetId: "original",
        format: "jpeg",
        metadataPolicy: "strip",
      },
    });
  });

  it("initializes stitch order from source image ids", () => {
    const doc = createDocument([image]);

    expect(doc.sourceImages).toEqual([image]);
    expect(doc.stitch.order).toEqual([image.id]);
  });

  it("initializes the document with an explicit metadata policy", () => {
    const doc = createDocument([image], { metadataPolicy: "retain-basic" });

    expect(doc.exportSettings.metadataPolicy).toBe("retain-basic");
  });

  it("parses a serialized current document without loss", () => {
    const doc = createDocument([image]);

    expect(parseDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    expect(parseDocumentJson(JSON.stringify(doc))).toEqual(doc);
  });

  it("routes current documents through the migration entry", () => {
    const doc = createDocument([image]);

    expect(migrateDocument(doc)).toEqual(doc);
  });

  it("reports malformed JSON as an invalid document", () => {
    expect(() => parseDocumentJson("{")).toThrow(DocumentParseError);
    expect(() => parseDocumentJson("{")).toThrow(
      expect.objectContaining({
        code: "invalid-document",
      }),
    );
  });

  it("reports a future schema version explicitly", () => {
    const future = {
      ...createEmptyDocument(),
      schemaVersion: DOCUMENT_SCHEMA_VERSION + 1,
    };

    expect(() => parseDocument(future)).toThrow(
      expect.objectContaining({
        code: "future-schema-version",
      }),
    );
  });

  it("reports an unsupported old schema version explicitly", () => {
    const old = { ...createEmptyDocument(), schemaVersion: 0 };

    expect(() => migrateDocument(old)).toThrow(
      expect.objectContaining({
        code: "unsupported-schema-version",
      }),
    );
  });

  const validNineImageDocument = createDocument(
    Array.from({ length: 9 }, (_, index) => ({
      ...image,
      id: `image-${index + 1}`,
    })),
  );

  const invalidDocuments: readonly (readonly [string, unknown])[] = [
    ["a non-object document", null],
    ["missing schema version", {}],
    ["a non-integer schema version", { schemaVersion: 1.5 }],
    [
      "more than nine images",
      {
        ...validNineImageDocument,
        sourceImages: [...validNineImageDocument.sourceImages, { ...image, id: "image-10" }],
        stitch: {
          ...validNineImageDocument.stitch,
          order: [...validNineImageDocument.stitch.order, "image-10"],
        },
      },
    ],
    [
      "non-positive source dimensions",
      {
        ...createDocument([image]),
        sourceImages: [{ ...image, width: 0 }],
      },
    ],
    [
      "non-finite source dimensions",
      {
        ...createDocument([image]),
        sourceImages: [{ ...image, height: Number.NaN }],
      },
    ],
    [
      "fractional source dimensions",
      {
        ...createDocument([image]),
        sourceImages: [{ ...image, width: 100.5 }],
      },
    ],
    ["a non-array source collection", { ...createEmptyDocument(), sourceImages: {} }],
    [
      "duplicate source ids",
      {
        ...createDocument([image]),
        sourceImages: [image, { ...image }],
        stitch: { mode: "vertical", spacing: 0, order: [image.id, image.id] },
      },
    ],
    [
      "an unsupported canvas ratio",
      {
        ...createDocument([image]),
        canvas: { ratio: "freeform", backgroundColor: "#FFFFFF" },
      },
    ],
    [
      "an empty background color",
      {
        ...createDocument([image]),
        canvas: { ratio: "original", backgroundColor: "" },
      },
    ],
    [
      "an unsupported stitch mode",
      {
        ...createDocument([image]),
        stitch: { mode: "freeform", spacing: 0, order: [image.id] },
      },
    ],
    [
      "a non-array stitch order",
      {
        ...createDocument([image]),
        stitch: { mode: "vertical", spacing: 0, order: image.id },
      },
    ],
    [
      "negative stitch spacing",
      {
        ...createDocument([image]),
        stitch: { mode: "vertical", spacing: -1, order: [image.id] },
      },
    ],
    [
      "stitch order that is not a source permutation",
      {
        ...createDocument([image]),
        stitch: { mode: "vertical", spacing: 0, order: ["missing"] },
      },
    ],
    [
      "invalid text geometry",
      {
        ...createDocument([image]),
        textElements: [{ ...textElement, width: -1 }],
      },
    ],
    [
      "a non-array text collection",
      {
        ...createDocument([image]),
        textElements: {},
      },
    ],
    [
      "duplicate text ids",
      {
        ...createDocument([image]),
        textElements: [textElement, textElement],
      },
    ],
    [
      "an unsupported text alignment",
      {
        ...createDocument([image]),
        textElements: [{ ...textElement, alignment: "justify" }],
      },
    ],
    [
      "a non-string text background",
      {
        ...createDocument([image]),
        textElements: [{ ...textElement, backgroundColor: 123 }],
      },
    ],
    [
      "an empty text background",
      {
        ...createDocument([image]),
        textElements: [{ ...textElement, backgroundColor: "" }],
      },
    ],
    [
      "a non-finite text position",
      {
        ...createDocument([image]),
        textElements: [{ ...textElement, position: { x: Number.NaN, y: 0 } }],
      },
    ],
    [
      "an unknown export preset",
      {
        ...createDocument([image]),
        exportSettings: {
          presetId: "custom",
          format: "jpeg",
          metadataPolicy: "strip",
        },
      },
    ],
    [
      "an unsupported export format",
      {
        ...createDocument([image]),
        exportSettings: {
          presetId: "original",
          format: "webp",
          metadataPolicy: "strip",
        },
      },
    ],
    [
      "an unsupported metadata policy",
      {
        ...createDocument([image]),
        exportSettings: {
          presetId: "original",
          format: "jpeg",
          metadataPolicy: "keep-gps",
        },
      },
    ],
  ];

  it.each(invalidDocuments)("rejects %s", (_name, candidate) => {
    expect(() => parseDocument(candidate)).toThrow(
      expect.objectContaining({
        code: "invalid-document",
      }),
    );
  });

  it("preserves parse errors when reading syntactically valid JSON", () => {
    const future = JSON.stringify({ schemaVersion: DOCUMENT_SCHEMA_VERSION + 1 });

    expect(() => parseDocumentJson(future)).toThrow(
      expect.objectContaining({ code: "future-schema-version" }),
    );
  });
});
