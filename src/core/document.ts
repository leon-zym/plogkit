/**
 * The serializable editing document is the single source of truth (ADR 0003).
 * Schema will grow feature by feature (specs F01-F07); every breaking change
 * must bump DOCUMENT_SCHEMA_VERSION and ship a migration.
 */
export const DOCUMENT_SCHEMA_VERSION = 1;

export interface CanvasSettings {
  /** Width / height. `null` means "follow source image ratio". */
  ratio: number | null;
  backgroundColor: string;
}

export interface PlogDocument {
  schemaVersion: typeof DOCUMENT_SCHEMA_VERSION;
  canvas: CanvasSettings;
}

export function createEmptyDocument(): PlogDocument {
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    canvas: {
      ratio: null,
      backgroundColor: "#FFFFFF",
    },
  };
}
