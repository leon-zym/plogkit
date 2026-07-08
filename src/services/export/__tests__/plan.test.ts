import { createDocument, type PlogDocument, type SourceImage } from "../../../core/document";
import { MAX_EXPORT_LONG_EDGE, MAX_EXPORT_PIXELS } from "../../../core/presets";
import { createExportPlan } from "../plan";

const source = (id: string): SourceImage => ({
  id,
  originalUri: `file:///${id}-original.jpg`,
  previewUri: `file:///${id}-preview.jpg`,
  width: 6000,
  height: 4000,
});

describe("export planning", () => {
  it("uses source resolution and the social preset independently of preview resolution", () => {
    const document = createDocument([
      {
        ...source("one"),
        width: 4000,
        height: 3000,
        previewUri: "file:///tiny-preview.jpg",
      },
    ]);

    expect(createExportPlan(document, { presetId: "social" })).toMatchObject({
      width: 2048,
      height: 1536,
      wasReduced: true,
      format: "jpeg",
      quality: 0.9,
    });
  });

  it("enforces both hard limits for a nine-image vertical original export", () => {
    const images = Array.from({ length: 9 }, (_, index) => source(`image-${index}`));
    const document = createDocument(images);
    const plan = createExportPlan(document);

    expect(Math.max(plan.width, plan.height)).toBeLessThanOrEqual(MAX_EXPORT_LONG_EDGE);
    expect(plan.width * plan.height).toBeLessThanOrEqual(MAX_EXPORT_PIXELS);
    expect(plan.wasReduced).toBe(true);
  });

  it("allows a one-off PNG and retain-basic override without changing the document", () => {
    const document = createDocument([source("one")]);
    const plan = createExportPlan(document, { format: "png", metadataPolicy: "retain-basic" });

    expect(plan).toMatchObject({
      format: "png",
      metadataPolicy: "retain-basic",
      extension: "png",
      mimeType: "image/png",
    });
    expect(document.exportSettings).toEqual({
      presetId: "original",
      format: "jpeg",
      metadataPolicy: "strip",
    });
  });

  it("preserves fixed canvas ratio in the planned output", () => {
    const base = createDocument([source("one")]);
    const document: PlogDocument = {
      ...base,
      canvas: { ...base.canvas, ratio: "4:5" },
    };
    const plan = createExportPlan(document, { presetId: "compact" });

    expect(plan.height).toBe(1280);
    expect(plan.width).toBe(1024);
  });
});
