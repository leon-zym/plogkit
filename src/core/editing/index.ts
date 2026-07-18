import { createStore } from "zustand/vanilla";

import {
  cloneDocument,
  DocumentParseError,
  isExactImageOrder,
  parseDocument,
  type CanvasRatio,
  type Point,
  type PlogDocument,
  type StitchMode,
  type TextAlignment,
  type TextElement,
} from "../document";
import {
  listPresetOptions,
  resolveExportPolicy,
  type ExportCapabilities,
  type ExportFormat,
  type ExportPresetId,
  type ExportSettings,
  type MetadataPolicy,
} from "../exportPolicy";

const HISTORY_LIMIT = 40;

interface DocumentHistory {
  readonly past: readonly PlogDocument[];
  readonly current: PlogDocument;
  readonly future: readonly PlogDocument[];
}

function createHistory(initial: PlogDocument): DocumentHistory {
  return { past: [], current: cloneDocument(initial), future: [] };
}

function canUndo(history: DocumentHistory): boolean {
  return history.past.length > 0;
}

function canRedo(history: DocumentHistory): boolean {
  return history.future.length > 0;
}

function commitHistory(history: DocumentHistory, next: PlogDocument): DocumentHistory {
  return {
    past: [...history.past, cloneDocument(history.current)].slice(-HISTORY_LIMIT),
    current: cloneDocument(next),
    future: [],
  };
}

function undoHistory(history: DocumentHistory): DocumentHistory {
  const previous = history.past.at(-1);
  if (previous === undefined) return history;
  return {
    past: history.past.slice(0, -1),
    current: cloneDocument(previous),
    future: [cloneDocument(history.current), ...history.future],
  };
}

function redoHistory(history: DocumentHistory): DocumentHistory {
  const next = history.future[0];
  if (next === undefined) return history;
  return {
    past: [...history.past, cloneDocument(history.current)].slice(-HISTORY_LIMIT),
    current: cloneDocument(next),
    future: history.future.slice(1),
  };
}

type TextElementUpdate = Partial<{
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

function addTextElement(document: PlogDocument, element: TextElement): PlogDocument {
  return parseDocument({ ...document, textElements: [...document.textElements, element] });
}

function updateTextElement(
  document: PlogDocument,
  id: string,
  update: TextElementUpdate,
): PlogDocument {
  if (update.content === "") return removeTextElement(document, id);
  return parseDocument({
    ...document,
    textElements: document.textElements.map((element) =>
      element.id === id ? { ...element, ...update } : element,
    ),
  });
}

function removeTextElement(document: PlogDocument, id: string): PlogDocument {
  return parseDocument({
    ...document,
    textElements: document.textElements.filter((element) => element.id !== id),
  });
}

function setBackgroundColor(document: PlogDocument, backgroundColor: string): PlogDocument {
  return parseDocument({ ...document, canvas: { ...document.canvas, backgroundColor } });
}

function setCanvasRatio(document: PlogDocument, ratio: CanvasRatio): PlogDocument {
  return parseDocument({ ...document, canvas: { ...document.canvas, ratio } });
}

function setStitchMode(document: PlogDocument, mode: StitchMode): PlogDocument {
  return parseDocument({ ...document, stitch: { ...document.stitch, mode } });
}

function setStitchSpacing(document: PlogDocument, spacing: number): PlogDocument {
  return parseDocument({ ...document, stitch: { ...document.stitch, spacing } });
}

function reorderImages(document: PlogDocument, order: readonly string[]): PlogDocument {
  return parseDocument({ ...document, stitch: { ...document.stitch, order } });
}

function setExportSettings(document: PlogDocument, exportSettings: ExportSettings): PlogDocument {
  return parseDocument({ ...document, exportSettings });
}

export type TextDraft = Pick<
  TextElement,
  "content" | "fontSize" | "color" | "alignment" | "lineHeight" | "backgroundColor"
>;

export type TextStyleDraft = Omit<TextDraft, "content">;

export type EditIntent =
  | {
      readonly type: "canvas.change-background";
      readonly color: string;
    }
  | {
      readonly type: "stitch.change-spacing";
      readonly spacing: number;
    }
  | {
      readonly type: "canvas.change-ratio";
      readonly ratio: CanvasRatio;
    }
  | {
      readonly type: "stitch.change-mode";
      readonly mode: StitchMode;
    }
  | {
      readonly type: "stitch.reorder-images";
      readonly imageIds: readonly string[];
    }
  | { readonly type: "export.change-preset"; readonly presetId: ExportPresetId }
  | { readonly type: "export.change-format"; readonly format: ExportFormat }
  | { readonly type: "export.change-metadata-policy"; readonly policy: MetadataPolicy }
  | {
      readonly type: "text.add";
      readonly draft: TextDraft;
    }
  | {
      readonly type: "text.replace-draft";
      readonly id: string;
      readonly draft: TextDraft;
    }
  | {
      readonly type: "text.apply-style";
      readonly id: string;
      readonly style: TextStyleDraft;
    }
  | {
      readonly type: "text.move";
      readonly id: string;
      readonly position: Point;
    }
  | {
      readonly type: "text.remove";
      readonly id: string;
    };

export type EditMessage =
  | {
      readonly type: "commit";
      readonly intent: EditIntent;
    }
  | {
      readonly type: "preview";
      readonly intent: EditIntent;
    }
  | { readonly type: "cancel-preview" }
  | { readonly type: "undo" }
  | { readonly type: "redo" };

export interface EditCommitSnapshot {
  readonly document: PlogDocument;
  readonly previewDocument: PlogDocument;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly revision: number;
}

export type DocumentEntityRef = { readonly kind: "text"; readonly id: string };

export interface EditEffects {
  readonly created: readonly DocumentEntityRef[];
  readonly removed: readonly DocumentEntityRef[];
}

export type EditResult =
  | {
      readonly status: "changed";
      readonly revision: number;
      readonly effects: EditEffects;
    }
  | { readonly status: "previewed" }
  | { readonly status: "unchanged" }
  | { readonly status: "rejected"; readonly code: EditRejectionCode };

export type EditRejectionCode =
  "duplicate-entity" | "entity-not-found" | "invalid-order" | "invalid-value";

export interface EditCommitModule {
  readonly read: () => EditCommitSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispatch: (message: EditMessage) => EditResult;
}

export interface CreateEditCommitModuleOptions {
  readonly initialDocument: PlogDocument;
  readonly onEditCommit?: (document: PlogDocument) => void;
  readonly createTextId?: () => string;
  readonly exportCapabilities: ExportCapabilities;
}

export const editIntents = {
  canvas: {
    changeBackground: (color: string): EditIntent => ({
      type: "canvas.change-background",
      color,
    }),
    changeRatio: (ratio: CanvasRatio): EditIntent => ({
      type: "canvas.change-ratio",
      ratio,
    }),
  },
  stitch: {
    changeMode: (mode: StitchMode): EditIntent => ({
      type: "stitch.change-mode",
      mode,
    }),
    changeSpacing: (spacing: number): EditIntent => ({
      type: "stitch.change-spacing",
      spacing,
    }),
    reorderImages: (imageIds: readonly string[]): EditIntent => ({
      type: "stitch.reorder-images",
      imageIds,
    }),
  },
  export: {
    changePreset: (presetId: ExportPresetId): EditIntent => ({
      type: "export.change-preset",
      presetId,
    }),
    changeFormat: (format: ExportFormat): EditIntent => ({
      type: "export.change-format",
      format,
    }),
    changeMetadataPolicy: (policy: MetadataPolicy): EditIntent => ({
      type: "export.change-metadata-policy",
      policy,
    }),
  },
  text: {
    add: (draft: TextDraft): EditIntent => ({
      type: "text.add",
      draft,
    }),
    replaceDraft: (id: string, draft: TextDraft): EditIntent => ({
      type: "text.replace-draft",
      id,
      draft,
    }),
    applyStyle: (id: string, style: TextStyleDraft): EditIntent => ({
      type: "text.apply-style",
      id,
      style,
    }),
    move: (id: string, position: Point): EditIntent => ({
      type: "text.move",
      id,
      position,
    }),
    remove: (id: string): EditIntent => ({
      type: "text.remove",
      id,
    }),
  },
} as const;

function documentsEqual(left: PlogDocument, right: PlogDocument): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function diffEntityEffects(previous: PlogDocument, next: PlogDocument): EditEffects {
  const previousTextIds = new Set(previous.textElements.map(({ id }) => id));
  const nextTextIds = new Set(next.textElements.map(({ id }) => id));
  return {
    created: next.textElements
      .filter(({ id }) => !previousTextIds.has(id))
      .map(({ id }) => ({ kind: "text" as const, id })),
    removed: previous.textElements
      .filter(({ id }) => !nextTextIds.has(id))
      .map(({ id }) => ({ kind: "text" as const, id })),
  };
}

class EditIntentRejection extends Error {
  readonly code: EditRejectionCode;

  constructor(code: EditRejectionCode) {
    super(code);
    this.code = code;
  }
}

let textSequence = 0;

function defaultCreateTextId(): string {
  textSequence += 1;
  return `text-${Date.now()}-${textSequence}`;
}

function requireTextElement(document: PlogDocument, id: string): void {
  if (!document.textElements.some((element) => element.id === id)) {
    throw new EditIntentRejection("entity-not-found");
  }
}

function requirePresetOption(presetId: ExportPresetId) {
  const option = listPresetOptions().find(({ id }) => id === presetId);
  if (option === undefined) throw new EditIntentRejection("invalid-value");
  return option;
}

function normalizeMetadataCompatibility(
  settings: ExportSettings,
  capabilities: ExportCapabilities,
): ExportSettings {
  requirePresetOption(settings.presetId);
  const resolution = resolveExportPolicy(
    settings,
    { naturalWidth: 1, naturalHeight: 1 },
    capabilities,
  );
  if (
    resolution.status === "failed" &&
    resolution.error.code === "unsupported-policy" &&
    (resolution.error.reason === "metadata-not-allowed" ||
      resolution.error.reason === "metadata-unsupported")
  ) {
    return { ...settings, metadataPolicy: "strip" };
  }
  return settings;
}

function applyIntent(
  document: PlogDocument,
  intent: EditIntent,
  createTextId: () => string,
  exportCapabilities: ExportCapabilities,
): PlogDocument {
  let nextDocument: PlogDocument;
  switch (intent.type) {
    case "canvas.change-background":
      if (intent.color.length === 0) throw new EditIntentRejection("invalid-value");
      nextDocument = setBackgroundColor(document, intent.color);
      break;
    case "canvas.change-ratio":
      nextDocument = setCanvasRatio(document, intent.ratio);
      break;
    case "stitch.change-spacing":
      if (!Number.isFinite(intent.spacing) || intent.spacing < 0) {
        throw new EditIntentRejection("invalid-value");
      }
      nextDocument = setStitchSpacing(document, intent.spacing);
      break;
    case "stitch.change-mode":
      nextDocument = setStitchMode(document, intent.mode);
      break;
    case "stitch.reorder-images": {
      const currentIds = document.sourceImages.map(({ id }) => id);
      if (!isExactImageOrder(intent.imageIds, currentIds)) {
        throw new EditIntentRejection("invalid-order");
      }
      nextDocument = reorderImages(document, intent.imageIds);
      break;
    }
    case "export.change-preset": {
      requirePresetOption(intent.presetId);
      nextDocument = setExportSettings(
        document,
        normalizeMetadataCompatibility(
          {
            presetId: intent.presetId,
            metadataPolicy: document.exportSettings.metadataPolicy,
          },
          exportCapabilities,
        ),
      );
      break;
    }
    case "export.change-format": {
      const option = requirePresetOption(document.exportSettings.presetId);
      if (!option.allowedFormats.includes(intent.format)) {
        throw new EditIntentRejection("invalid-value");
      }
      nextDocument = setExportSettings(
        document,
        normalizeMetadataCompatibility(
          {
            ...document.exportSettings,
            ...(intent.format === option.defaultFormat
              ? { formatOverride: undefined }
              : { formatOverride: intent.format }),
          },
          exportCapabilities,
        ),
      );
      break;
    }
    case "export.change-metadata-policy": {
      const settings = normalizeMetadataCompatibility(
        {
          ...document.exportSettings,
          metadataPolicy: intent.policy,
        },
        exportCapabilities,
      );
      if (settings.metadataPolicy !== intent.policy) {
        throw new EditIntentRejection("invalid-value");
      }
      nextDocument = setExportSettings(document, settings);
      break;
    }
    case "text.add": {
      if (intent.draft.content.length === 0) throw new EditIntentRejection("invalid-value");
      const id = createTextId();
      if (document.textElements.some((element) => element.id === id)) {
        throw new EditIntentRejection("duplicate-entity");
      }
      nextDocument = addTextElement(document, {
        id,
        ...intent.draft,
        position: { x: 80, y: 80 },
        width: 840,
        fontId: "system-sans",
      });
      break;
    }
    case "text.replace-draft": {
      requireTextElement(document, intent.id);
      nextDocument = updateTextElement(document, intent.id, intent.draft);
      break;
    }
    case "text.apply-style": {
      requireTextElement(document, intent.id);
      nextDocument = updateTextElement(document, intent.id, intent.style);
      break;
    }
    case "text.move": {
      requireTextElement(document, intent.id);
      nextDocument = updateTextElement(document, intent.id, { position: intent.position });
      break;
    }
    case "text.remove": {
      requireTextElement(document, intent.id);
      nextDocument = removeTextElement(document, intent.id);
      break;
    }
  }
  return nextDocument;
}

export function createEditCommitModule({
  initialDocument,
  onEditCommit = () => undefined,
  createTextId = defaultCreateTextId,
  exportCapabilities,
}: CreateEditCommitModuleOptions): EditCommitModule {
  let history = createHistory(initialDocument);
  let revision = 0;
  const store = createStore<EditCommitSnapshot>()(() => ({
    document: history.current,
    previewDocument: history.current,
    canUndo: false,
    canRedo: false,
    revision,
  }));
  let isDispatching = false;

  const publishHistory = (nextHistory: DocumentHistory): EditResult => {
    const effects = diffEntityEffects(history.current, nextHistory.current);
    history = nextHistory;
    revision += 1;
    let notificationError: unknown;
    try {
      store.setState({
        document: history.current,
        previewDocument: history.current,
        canUndo: canUndo(history),
        canRedo: canRedo(history),
        revision,
      });
    } catch (error: unknown) {
      notificationError = error;
    }
    onEditCommit(history.current);
    if (notificationError !== undefined) throw notificationError;
    return {
      status: "changed",
      revision,
      effects,
    };
  };

  const dispatch = (message: EditMessage): EditResult => {
    if (isDispatching) {
      throw new Error("edit dispatch must not be reentrant");
    }
    isDispatching = true;
    try {
      if (message.type === "cancel-preview") {
        store.setState({ previewDocument: history.current });
        return { status: "unchanged" };
      }
      if (message.type === "undo") {
        if (!canUndo(history)) {
          store.setState({ previewDocument: history.current });
          return { status: "unchanged" };
        }
        return publishHistory(undoHistory(history));
      }
      if (message.type === "redo") {
        if (!canRedo(history)) {
          store.setState({ previewDocument: history.current });
          return { status: "unchanged" };
        }
        return publishHistory(redoHistory(history));
      }

      let nextDocument: PlogDocument;
      try {
        nextDocument = applyIntent(
          history.current,
          message.intent,
          createTextId,
          exportCapabilities,
        );
      } catch (error: unknown) {
        if (error instanceof EditIntentRejection) {
          return { status: "rejected", code: error.code };
        }
        if (error instanceof DocumentParseError) {
          return { status: "rejected", code: "invalid-value" };
        }
        throw error;
      }
      if (message.type === "preview") {
        store.setState({ previewDocument: nextDocument });
        return { status: "previewed" };
      }
      if (documentsEqual(history.current, nextDocument)) {
        store.setState({ previewDocument: history.current });
        return { status: "unchanged" };
      }
      return publishHistory(commitHistory(history, nextDocument));
    } finally {
      isDispatching = false;
    }
  };

  return {
    read: store.getState,
    subscribe: (listener) => store.subscribe(listener),
    dispatch,
  };
}
