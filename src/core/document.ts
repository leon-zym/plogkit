/**
 * The serializable editing document is the single source of truth (ADR 0003).
 */
import {
  listPresetOptions,
  parseExportSettings,
  type ExportSettings,
  type MetadataPolicy,
} from "./exportPolicy";

export const DOCUMENT_SCHEMA_VERSION = 1;
export const MAX_SOURCE_IMAGES = 9;

export const CANVAS_RATIOS = ["original", "1:1", "3:4", "4:5", "9:16"] as const;
export type CanvasRatio = (typeof CANVAS_RATIOS)[number];

export type StitchMode = "vertical" | "grid";
export type TextAlignment = "left" | "center" | "right";

export interface SourceImage {
  readonly id: string;
  readonly originalUri: string;
  readonly previewUri: string;
  readonly width: number;
  readonly height: number;
}

export interface CanvasSettings {
  readonly ratio: CanvasRatio;
  readonly backgroundColor: string;
}

export interface StitchSettings {
  readonly mode: StitchMode;
  readonly spacing: number;
  readonly order: readonly string[];
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface TextElement {
  readonly id: string;
  readonly content: string;
  readonly position: Point;
  readonly width: number;
  readonly fontId: string;
  readonly fontSize: number;
  readonly color: string;
  readonly alignment: TextAlignment;
  readonly lineHeight: number;
  readonly backgroundColor: string | null;
}

export interface PlogDocument {
  readonly schemaVersion: typeof DOCUMENT_SCHEMA_VERSION;
  readonly sourceImages: readonly SourceImage[];
  readonly canvas: CanvasSettings;
  readonly stitch: StitchSettings;
  readonly textElements: readonly TextElement[];
  readonly exportSettings: ExportSettings;
}

export type DocumentParseErrorCode =
  "invalid-document" | "future-schema-version" | "unsupported-schema-version";

export class DocumentParseError extends Error {
  readonly code: DocumentParseErrorCode;

  constructor(code: DocumentParseErrorCode, message: string) {
    super(message);
    this.name = "DocumentParseError";
    this.code = code;
  }
}

type DocumentMigration = (input: unknown) => unknown;

/** Add a migration at key N when schema N needs to become schema N + 1. */
export const DOCUMENT_MIGRATIONS: Readonly<Partial<Record<number, DocumentMigration>>> =
  Object.freeze({});

function invalid(message: string): never {
  throw new DocumentParseError("invalid-document", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    return invalid(`${path} must be an object`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return invalid(`${path} must be a non-empty string`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return invalid(`${path} must be a finite number`);
  }
  return value;
}

function requirePositiveNumber(value: unknown, path: string): number {
  const number = requireFiniteNumber(value, path);
  if (number <= 0) {
    return invalid(`${path} must be positive`);
  }
  return number;
}

function requirePositiveInteger(value: unknown, path: string): number {
  const number = requirePositiveNumber(value, path);
  if (!Number.isInteger(number)) {
    return invalid(`${path} must be an integer`);
  }
  return number;
}

function requireNonNegativeNumber(value: unknown, path: string): number {
  const number = requireFiniteNumber(value, path);
  if (number < 0) {
    return invalid(`${path} must be non-negative`);
  }
  return number;
}

function parseSourceImage(value: unknown, index: number): SourceImage {
  const path = `sourceImages[${index}]`;
  const record = requireRecord(value, path);
  return {
    id: requireNonEmptyString(record.id, `${path}.id`),
    originalUri: requireNonEmptyString(record.originalUri, `${path}.originalUri`),
    previewUri: requireNonEmptyString(record.previewUri, `${path}.previewUri`),
    width: requirePositiveInteger(record.width, `${path}.width`),
    height: requirePositiveInteger(record.height, `${path}.height`),
  };
}

function parseSourceImages(value: unknown): readonly SourceImage[] {
  if (!Array.isArray(value)) {
    return invalid("sourceImages must be an array");
  }
  if (value.length > MAX_SOURCE_IMAGES) {
    return invalid(`sourceImages supports at most ${MAX_SOURCE_IMAGES} images`);
  }

  const images = value.map(parseSourceImage);
  const ids = images.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    return invalid("sourceImages ids must be unique");
  }
  return images;
}

function isCanvasRatio(value: unknown): value is CanvasRatio {
  return (
    value === "original" ||
    value === "1:1" ||
    value === "3:4" ||
    value === "4:5" ||
    value === "9:16"
  );
}

function parseCanvas(value: unknown): CanvasSettings {
  const record = requireRecord(value, "canvas");
  if (!isCanvasRatio(record.ratio)) {
    return invalid("canvas.ratio is not supported");
  }
  return {
    ratio: record.ratio,
    backgroundColor: requireNonEmptyString(record.backgroundColor, "canvas.backgroundColor"),
  };
}

export function isExactImageOrder(order: readonly string[], imageIds: readonly string[]): boolean {
  if (order.length !== imageIds.length || new Set(order).size !== order.length) {
    return false;
  }
  const expected = new Set(imageIds);
  return order.every((id) => expected.has(id));
}

function parseStitch(value: unknown, imageIds: readonly string[]): StitchSettings {
  const record = requireRecord(value, "stitch");
  if (record.mode !== "vertical" && record.mode !== "grid") {
    return invalid("stitch.mode must be vertical or grid");
  }
  if (!Array.isArray(record.order)) {
    return invalid("stitch.order must be an array");
  }
  const order = record.order.map((id, index) =>
    requireNonEmptyString(id, `stitch.order[${index}]`),
  );
  if (!isExactImageOrder(order, imageIds)) {
    return invalid("stitch.order must be an exact permutation of source image ids");
  }
  return {
    mode: record.mode,
    spacing: requireNonNegativeNumber(record.spacing, "stitch.spacing"),
    order,
  };
}

function parseTextElement(value: unknown, index: number): TextElement {
  const path = `textElements[${index}]`;
  const record = requireRecord(value, path);
  const position = requireRecord(record.position, `${path}.position`);
  if (
    record.alignment !== "left" &&
    record.alignment !== "center" &&
    record.alignment !== "right"
  ) {
    return invalid(`${path}.alignment is not supported`);
  }
  if (record.backgroundColor !== null && typeof record.backgroundColor !== "string") {
    return invalid(`${path}.backgroundColor must be a string or null`);
  }
  if (record.backgroundColor === "") {
    return invalid(`${path}.backgroundColor must not be empty`);
  }

  return {
    id: requireNonEmptyString(record.id, `${path}.id`),
    content: requireNonEmptyString(record.content, `${path}.content`),
    position: {
      x: requireFiniteNumber(position.x, `${path}.position.x`),
      y: requireFiniteNumber(position.y, `${path}.position.y`),
    },
    width: requirePositiveNumber(record.width, `${path}.width`),
    fontId: requireNonEmptyString(record.fontId, `${path}.fontId`),
    fontSize: requirePositiveNumber(record.fontSize, `${path}.fontSize`),
    color: requireNonEmptyString(record.color, `${path}.color`),
    alignment: record.alignment,
    lineHeight: requirePositiveNumber(record.lineHeight, `${path}.lineHeight`),
    backgroundColor: record.backgroundColor,
  };
}

function parseTextElements(value: unknown): readonly TextElement[] {
  if (!Array.isArray(value)) {
    return invalid("textElements must be an array");
  }
  const elements = value.map(parseTextElement);
  const ids = elements.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    return invalid("textElements ids must be unique");
  }
  return elements;
}

function parseDocumentExportSettings(value: unknown): ExportSettings {
  try {
    return parseExportSettings(value);
  } catch (error: unknown) {
    return invalid(error instanceof Error ? error.message : "export settings are invalid");
  }
}

function validateCurrentDocument(input: unknown): PlogDocument {
  const record = requireRecord(input, "document");
  if (record.schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
    return invalid("document schemaVersion is not current");
  }
  const sourceImages = parseSourceImages(record.sourceImages);
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    sourceImages,
    canvas: parseCanvas(record.canvas),
    stitch: parseStitch(
      record.stitch,
      sourceImages.map(({ id }) => id),
    ),
    textElements: parseTextElements(record.textElements),
    exportSettings: parseDocumentExportSettings(record.exportSettings),
  };
}

function readSchemaVersion(input: unknown): number {
  const record = requireRecord(input, "document");
  if (typeof record.schemaVersion !== "number" || !Number.isInteger(record.schemaVersion)) {
    return invalid("document.schemaVersion must be an integer");
  }
  return record.schemaVersion;
}

export function migrateDocument(input: unknown): PlogDocument {
  let candidate = input;
  let version = readSchemaVersion(candidate);

  if (version > DOCUMENT_SCHEMA_VERSION) {
    throw new DocumentParseError(
      "future-schema-version",
      `document schema ${version} is newer than supported schema ${DOCUMENT_SCHEMA_VERSION}`,
    );
  }

  while (version < DOCUMENT_SCHEMA_VERSION) {
    const migration = DOCUMENT_MIGRATIONS[version];
    if (migration === undefined) {
      throw new DocumentParseError(
        "unsupported-schema-version",
        `document schema ${version} has no migration path`,
      );
    }
    candidate = migration(candidate);
    const migratedVersion = readSchemaVersion(candidate);
    if (migratedVersion !== version + 1) {
      return invalid(`migration ${version} did not produce schema ${version + 1}`);
    }
    version = migratedVersion;
  }

  return validateCurrentDocument(candidate);
}

export function parseDocument(input: unknown): PlogDocument {
  return migrateDocument(input);
}

export function parseDocumentJson(json: string): PlogDocument {
  try {
    const input: unknown = JSON.parse(json);
    return parseDocument(input);
  } catch (error: unknown) {
    if (error instanceof DocumentParseError) {
      throw error;
    }
    throw new DocumentParseError("invalid-document", "document JSON is malformed");
  }
}

export function cloneDocument(document: PlogDocument): PlogDocument {
  return parseDocumentJson(JSON.stringify(document));
}

export interface CreateDocumentOptions {
  readonly metadataPolicy?: MetadataPolicy;
}

export function createDocument(
  sourceImages: readonly SourceImage[] = [],
  { metadataPolicy = "strip" }: CreateDocumentOptions = {},
): PlogDocument {
  const defaultPreset = listPresetOptions()[0];
  if (defaultPreset === undefined) throw new Error("export preset catalog is empty");
  return parseDocument({
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    sourceImages,
    canvas: {
      ratio: "original",
      backgroundColor: "#FFFFFF",
    },
    stitch: {
      mode: "vertical",
      spacing: 0,
      order: sourceImages.map(({ id }) => id),
    },
    textElements: [],
    exportSettings: {
      presetId: defaultPreset.id,
      metadataPolicy,
    },
  });
}

export function createEmptyDocument(): PlogDocument {
  return createDocument();
}
