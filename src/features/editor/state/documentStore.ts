import {
  canRedo,
  canUndo,
  commitHistory,
  createHistory,
  redoHistory,
  undoHistory,
  type DocumentHistory,
} from "@/core/history";
import type { PlogDocument } from "@/core/document";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

export type EditorTool = "none" | "text" | "background" | "stitch" | "export";

export interface EditorDocumentState {
  readonly document: PlogDocument;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly selectedTextId: string | null;
  readonly activeTool: EditorTool;
  readonly commit: (document: PlogDocument) => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly setSelectedTextId: (id: string | null) => void;
  readonly setActiveTool: (tool: EditorTool) => void;
}

export interface CreateEditorDocumentStoreOptions {
  readonly initialDocument: PlogDocument;
  readonly onDocumentCommit?: (document: PlogDocument) => void;
}

export type EditorDocumentStore = StoreApi<EditorDocumentState>;

function nextSelectedTextId(document: PlogDocument, selectedTextId: string | null): string | null {
  if (selectedTextId !== null && !document.textElements.some(({ id }) => id === selectedTextId)) {
    return null;
  }
  return selectedTextId;
}

export function createEditorDocumentStore({
  initialDocument,
  onDocumentCommit = () => undefined,
}: CreateEditorDocumentStoreOptions): EditorDocumentStore {
  let history: DocumentHistory = createHistory(initialDocument);

  return createStore<EditorDocumentState>()((set, get) => {
    const publishHistory = (nextHistory: DocumentHistory): void => {
      history = nextHistory;
      const document = history.current;
      set({
        document,
        canUndo: canUndo(history),
        canRedo: canRedo(history),
        selectedTextId: nextSelectedTextId(document, get().selectedTextId),
      });
      onDocumentCommit(document);
    };

    return {
      document: history.current,
      canUndo: false,
      canRedo: false,
      selectedTextId: null,
      activeTool: "none",
      commit: (document) => publishHistory(commitHistory(history, document)),
      undo: () => {
        if (canUndo(history)) publishHistory(undoHistory(history));
      },
      redo: () => {
        if (canRedo(history)) publishHistory(redoHistory(history));
      },
      setSelectedTextId: (selectedTextId) => set({ selectedTextId }),
      setActiveTool: (activeTool) => set({ activeTool }),
    };
  });
}

export function useEditorDocumentStore<T>(
  store: EditorDocumentStore,
  selector: (state: EditorDocumentState) => T,
): T {
  return useStore(store, selector);
}
