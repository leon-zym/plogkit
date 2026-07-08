import { createEmptyDocument } from "@/core/document";
import { setBackgroundColor } from "@/core/operations";

import { createEditorDocumentStore } from "../documentStore";

describe("editor document store", () => {
  it("commits document snapshots and notifies autosave", () => {
    const onDocumentCommit = jest.fn();
    const initial = createEmptyDocument();
    const store = createEditorDocumentStore({ initialDocument: initial, onDocumentCommit });
    const next = setBackgroundColor(initial, "#111111");

    store.getState().commit(next);

    expect(store.getState().document).toEqual(next);
    expect(store.getState().canUndo).toBe(true);
    expect(onDocumentCommit).toHaveBeenCalledWith(next);
  });

  it("undoes, redoes, and clears redo after a new commit", () => {
    const onDocumentCommit = jest.fn();
    const initial = createEmptyDocument();
    const store = createEditorDocumentStore({ initialDocument: initial, onDocumentCommit });

    store.getState().commit(setBackgroundColor(initial, "#111111"));
    store.getState().undo();
    expect(store.getState().document).toEqual(initial);
    expect(store.getState().canRedo).toBe(true);

    store.getState().redo();
    expect(store.getState().document.canvas.backgroundColor).toBe("#111111");

    store.getState().undo();
    store.getState().commit(setBackgroundColor(store.getState().document, "#222222"));
    expect(store.getState().canRedo).toBe(false);
    expect(onDocumentCommit).toHaveBeenCalledTimes(5);
  });

  it("keeps transient editor state outside history and autosave", () => {
    const onDocumentCommit = jest.fn();
    const store = createEditorDocumentStore({
      initialDocument: createEmptyDocument(),
      onDocumentCommit,
    });

    store.getState().setActiveTool("text");
    store.getState().setSelectedTextId("text-1");

    expect(store.getState()).toMatchObject({
      activeTool: "text",
      selectedTextId: "text-1",
      canUndo: false,
    });
    expect(onDocumentCommit).not.toHaveBeenCalled();
  });
});
