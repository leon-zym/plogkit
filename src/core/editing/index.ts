import { createStore } from "zustand/vanilla";

import {
  isExactImageOrder,
  type CanvasRatio,
  type ExportSettings,
  type Point,
  type PlogDocument,
  type StitchMode,
  type TextElement,
} from "../document";
import {
  canRedo,
  canUndo,
  commitHistory,
  createHistory,
  redoHistory,
  undoHistory,
  type DocumentHistory,
} from "../history";
import {
  addTextElement,
  removeTextElement,
  setBackgroundColor,
  setCanvasRatio,
  reorderImages,
  setStitchMode,
  setStitchSpacing,
  setExportSettings,
  updateTextElement,
} from "../operations";

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
  | {
      readonly type: "export.change-settings";
      readonly settings: ExportSettings;
    }
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
    changeSettings: (settings: ExportSettings): EditIntent => ({
      type: "export.change-settings",
      settings,
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

interface AppliedIntent {
  readonly document: PlogDocument;
  readonly effects: EditEffects;
}

let textSequence = 0;

function defaultCreateTextId(): string {
  textSequence += 1;
  return `text-${Date.now()}-${textSequence}`;
}

function applyIntent(
  document: PlogDocument,
  intent: EditIntent,
  createTextId: () => string,
): AppliedIntent {
  let nextDocument: PlogDocument;
  let effects: EditEffects = { created: [], removed: [] };
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
    case "export.change-settings":
      nextDocument = setExportSettings(document, intent.settings);
      break;
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
      effects = { created: [{ kind: "text", id }], removed: [] };
      break;
    }
    case "text.replace-draft": {
      if (!document.textElements.some((element) => element.id === intent.id)) {
        throw new EditIntentRejection("entity-not-found");
      }
      nextDocument = updateTextElement(document, intent.id, intent.draft);
      if (intent.draft.content.length === 0) {
        effects = { created: [], removed: [{ kind: "text", id: intent.id }] };
      }
      break;
    }
    case "text.apply-style": {
      if (!document.textElements.some((element) => element.id === intent.id)) {
        throw new EditIntentRejection("entity-not-found");
      }
      nextDocument = updateTextElement(document, intent.id, intent.style);
      break;
    }
    case "text.move": {
      if (!document.textElements.some((element) => element.id === intent.id)) {
        throw new EditIntentRejection("entity-not-found");
      }
      nextDocument = updateTextElement(document, intent.id, { position: intent.position });
      break;
    }
    case "text.remove": {
      if (!document.textElements.some((element) => element.id === intent.id)) {
        throw new EditIntentRejection("entity-not-found");
      }
      nextDocument = removeTextElement(document, intent.id);
      effects = { created: [], removed: [{ kind: "text", id: intent.id }] };
      break;
    }
  }
  return { document: nextDocument, effects };
}

export function createEditCommitModule({
  initialDocument,
  onEditCommit = () => undefined,
  createTextId = defaultCreateTextId,
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

  const publishHistory = (
    nextHistory: DocumentHistory,
    effects: EditEffects = diffEntityEffects(history.current, nextHistory.current),
  ): EditResult => {
    history = nextHistory;
    revision += 1;
    store.setState({
      document: history.current,
      previewDocument: history.current,
      canUndo: canUndo(history),
      canRedo: canRedo(history),
      revision,
    });
    onEditCommit(history.current);
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

      let applied: AppliedIntent;
      try {
        applied = applyIntent(history.current, message.intent, createTextId);
      } catch (error: unknown) {
        if (error instanceof EditIntentRejection) {
          return { status: "rejected", code: error.code };
        }
        throw error;
      }
      const nextDocument = applied.document;
      if (message.type === "preview") {
        store.setState({ previewDocument: nextDocument });
        return { status: "previewed" };
      }
      if (documentsEqual(history.current, nextDocument)) {
        store.setState({ previewDocument: history.current });
        return { status: "unchanged" };
      }
      return publishHistory(commitHistory(history, nextDocument), applied.effects);
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
