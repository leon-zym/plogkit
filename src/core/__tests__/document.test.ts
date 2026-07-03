import { createEmptyDocument, DOCUMENT_SCHEMA_VERSION } from "../document";

describe("document model", () => {
  it("creates an empty document stamped with the current schema version", () => {
    const doc = createEmptyDocument();
    expect(doc.schemaVersion).toBe(DOCUMENT_SCHEMA_VERSION);
  });

  it("round-trips through JSON serialization without loss", () => {
    const doc = createEmptyDocument();
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });
});
