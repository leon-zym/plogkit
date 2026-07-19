import { createDocument, createEmptyDocument, type SourceImage } from "../../document";
import { listPresetOptions } from "../../exportPolicy";
import { SKIA_EXPORT_CAPABILITIES } from "../../../services/export/capabilities";
import {
  createEditCommitModule as createRuntimeEditCommitModule,
  editIntents,
  type CreateEditCommitModuleOptions,
  type TextDraft,
} from "../index";

const images: readonly SourceImage[] = [
  {
    id: "image-1",
    originalUri: "file:///image-1.jpg",
    previewUri: "file:///image-1-preview.jpg",
    width: 1200,
    height: 800,
  },
  {
    id: "image-2",
    originalUri: "file:///image-2.jpg",
    previewUri: "file:///image-2-preview.jpg",
    width: 800,
    height: 1200,
  },
];

const textDraft: TextDraft = {
  content: "周末的海边日记",
  fontSize: 40,
  color: "#FFFFFF",
  alignment: "left",
  lineHeight: 1.35,
  backgroundColor: null,
};

function createEditCommitModule(
  options: Omit<CreateEditCommitModuleOptions, "exportCapabilities">,
) {
  return createRuntimeEditCommitModule({
    ...options,
    exportCapabilities: SKIA_EXPORT_CAPABILITIES,
  });
}

describe("edit commit module", () => {
  it("turns one canvas intent into one edit commit", () => {
    const autosaved = jest.fn();
    const editing = createEditCommitModule({
      initialDocument: createEmptyDocument(),
      onEditCommit: autosaved,
    });

    const result = editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#112233"),
    });

    expect(result).toMatchObject({ status: "changed", revision: 1 });
    expect(editing.read()).toMatchObject({
      document: { canvas: { backgroundColor: "#112233" } },
      previewDocument: { canvas: { backgroundColor: "#112233" } },
      canUndo: true,
      canRedo: false,
      revision: 1,
    });
    expect(autosaved).toHaveBeenCalledTimes(1);
    expect(autosaved).toHaveBeenCalledWith(editing.read().document);
  });

  it("does not create an edit commit when an intent changes nothing", () => {
    const autosaved = jest.fn();
    const editing = createEditCommitModule({
      initialDocument: createEmptyDocument(),
      onEditCommit: autosaved,
    });

    const result = editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#FFFFFF"),
    });

    expect(result).toEqual({ status: "unchanged" });
    expect(editing.read()).toMatchObject({ canUndo: false, revision: 0 });
    expect(autosaved).not.toHaveBeenCalled();
  });

  it("projects a preview without creating an edit commit", () => {
    const autosaved = jest.fn();
    const editing = createEditCommitModule({
      initialDocument: createEmptyDocument(),
      onEditCommit: autosaved,
    });

    const result = editing.dispatch({
      type: "preview",
      intent: editIntents.stitch.changeSpacing(18),
    });

    expect(result).toEqual({ status: "previewed" });
    expect(editing.read().document.stitch.spacing).toBe(0);
    expect(editing.read().previewDocument.stitch.spacing).toBe(18);
    expect(editing.read()).toMatchObject({ canUndo: false, revision: 0 });
    expect(autosaved).not.toHaveBeenCalled();
  });

  it("replaces the active preview instead of composing previews", () => {
    const editing = createEditCommitModule({ initialDocument: createEmptyDocument() });
    editing.dispatch({
      type: "preview",
      intent: editIntents.stitch.changeSpacing(18),
    });

    editing.dispatch({
      type: "preview",
      intent: editIntents.canvas.changeBackground("#112233"),
    });

    expect(editing.read().previewDocument).toMatchObject({
      canvas: { backgroundColor: "#112233" },
      stitch: { spacing: 0 },
    });
  });

  it("clears the active preview after a semantic no-op commit", () => {
    const editing = createEditCommitModule({ initialDocument: createEmptyDocument() });
    editing.dispatch({
      type: "preview",
      intent: editIntents.stitch.changeSpacing(18),
    });

    const result = editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#FFFFFF"),
    });

    expect(result).toEqual({ status: "unchanged" });
    expect(editing.read().previewDocument).toBe(editing.read().document);
  });

  it("rejects an invalid intent without changing any editing state", () => {
    const autosaved = jest.fn();
    const editing = createEditCommitModule({
      initialDocument: createEmptyDocument(),
      onEditCommit: autosaved,
    });
    const before = editing.read();

    const result = editing.dispatch({
      type: "preview",
      intent: editIntents.stitch.changeSpacing(-1),
    });

    expect(result).toEqual({ status: "rejected", code: "invalid-value" });
    expect(editing.read()).toBe(before);
    expect(autosaved).not.toHaveBeenCalled();
  });

  it("undoes and redoes edit commits while clearing an active preview", () => {
    const autosaved = jest.fn();
    const editing = createEditCommitModule({
      initialDocument: createEmptyDocument(),
      onEditCommit: autosaved,
    });
    editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#112233"),
    });
    editing.dispatch({
      type: "preview",
      intent: editIntents.stitch.changeSpacing(18),
    });

    const undone = editing.dispatch({ type: "undo" });

    expect(undone).toMatchObject({ status: "changed", revision: 2 });
    expect(editing.read()).toMatchObject({
      document: { canvas: { backgroundColor: "#FFFFFF" } },
      previewDocument: { canvas: { backgroundColor: "#FFFFFF" }, stitch: { spacing: 0 } },
      canUndo: false,
      canRedo: true,
      revision: 2,
    });

    const redone = editing.dispatch({ type: "redo" });

    expect(redone).toMatchObject({ status: "changed", revision: 3 });
    expect(editing.read()).toMatchObject({
      document: { canvas: { backgroundColor: "#112233" } },
      canUndo: true,
      canRedo: false,
      revision: 3,
    });
    expect(autosaved).toHaveBeenCalledTimes(3);
  });

  it("changes the canvas ratio through a semantic intent", () => {
    const editing = createEditCommitModule({ initialDocument: createEmptyDocument() });

    editing.dispatch({ type: "commit", intent: editIntents.canvas.changeRatio("4:5") });

    expect(editing.read().document.canvas.ratio).toBe("4:5");
  });

  it("changes the stitch mode through a semantic intent", () => {
    const editing = createEditCommitModule({ initialDocument: createEmptyDocument() });

    editing.dispatch({ type: "commit", intent: editIntents.stitch.changeMode("grid") });

    expect(editing.read().document.stitch.mode).toBe("grid");
  });

  it("reorders every source image atomically", () => {
    const editing = createEditCommitModule({ initialDocument: createDocument(images) });

    editing.dispatch({
      type: "commit",
      intent: editIntents.stitch.reorderImages(["image-2", "image-1"]),
    });

    expect(editing.read().document.stitch.order).toEqual(["image-2", "image-1"]);
  });

  it("switches preset and normalizes format and metadata as one edit commit", () => {
    const autosaved = jest.fn();
    const editing = createEditCommitModule({
      initialDocument: createDocument([], { metadataPolicy: "retain-basic" }),
      onEditCommit: autosaved,
    });
    const socialPreset = listPresetOptions().find(({ id }) => id === "social");
    if (socialPreset === undefined) throw new Error("social preset fixture is missing");

    editing.dispatch({
      type: "commit",
      intent: editIntents.export.changeFormat("png"),
    });
    expect(editing.read().document.exportSettings).toEqual({
      presetId: "original",
      formatOverride: "png",
      metadataPolicy: "strip",
    });
    autosaved.mockClear();

    const switched = editing.dispatch({
      type: "commit",
      intent: editIntents.export.changePreset(socialPreset.id),
    });

    expect(switched).toMatchObject({ status: "changed", revision: 2 });
    expect(editing.read().document.exportSettings).toEqual({
      presetId: "social",
      metadataPolicy: "strip",
    });
    expect(autosaved).toHaveBeenCalledTimes(1);

    editing.dispatch({ type: "undo" });
    expect(editing.read().document.exportSettings).toEqual({
      presetId: "original",
      formatOverride: "png",
      metadataPolicy: "strip",
    });
  });

  it("safely strips metadata when the backend cannot retain it after a preset switch", () => {
    const editing = createRuntimeEditCommitModule({
      initialDocument: createDocument([], { metadataPolicy: "retain-basic" }),
      exportCapabilities: {
        ...SKIA_EXPORT_CAPABILITIES,
        metadataPolicies: { jpeg: ["strip"], png: ["strip"] },
      },
    });
    const socialPreset = listPresetOptions().find(({ id }) => id === "social");
    if (socialPreset === undefined) throw new Error("social preset fixture is missing");

    editing.dispatch({
      type: "commit",
      intent: editIntents.export.changePreset(socialPreset.id),
    });

    expect(editing.read().document.exportSettings).toEqual({
      presetId: "social",
      metadataPolicy: "strip",
    });
  });

  it("adds text with module-owned identity and placement defaults", () => {
    const editing = createEditCommitModule({
      initialDocument: createDocument(images),
      createTextId: () => "text-1",
    });

    const result = editing.dispatch({
      type: "commit",
      intent: editIntents.text.add(textDraft),
    });

    expect(result).toMatchObject({
      status: "changed",
      effects: { created: [{ kind: "text", id: "text-1" }], removed: [] },
    });
    expect(editing.read().document.textElements).toEqual([
      {
        id: "text-1",
        ...textDraft,
        position: { x: 80, y: 80 },
        width: 840,
        fontId: "system-sans",
      },
    ]);
  });

  it("previews a complete text draft without changing the committed text", () => {
    const editing = createEditCommitModule({
      initialDocument: createDocument(images),
      createTextId: () => "text-1",
    });
    editing.dispatch({ type: "commit", intent: editIntents.text.add(textDraft) });

    const result = editing.dispatch({
      type: "preview",
      intent: editIntents.text.replaceDraft("text-1", {
        ...textDraft,
        content: "预览中的文字",
        fontSize: 64,
      }),
    });

    expect(result).toEqual({ status: "previewed" });
    expect(editing.read().document.textElements[0]).toMatchObject({
      content: "周末的海边日记",
      fontSize: 40,
    });
    expect(editing.read().previewDocument.textElements[0]).toMatchObject({
      content: "预览中的文字",
      fontSize: 64,
    });
  });

  it("applies a text style as one edit commit", () => {
    const editing = createEditCommitModule({
      initialDocument: createDocument(images),
      createTextId: () => "text-1",
    });
    editing.dispatch({ type: "commit", intent: editIntents.text.add(textDraft) });

    editing.dispatch({
      type: "commit",
      intent: editIntents.text.applyStyle("text-1", {
        fontSize: 64,
        color: "#1D1B18",
        alignment: "center",
        lineHeight: 1.1,
        backgroundColor: "#FFFFFFCC",
      }),
    });

    expect(editing.read().document.textElements[0]).toMatchObject({
      content: "周末的海边日记",
      fontSize: 64,
      color: "#1D1B18",
      alignment: "center",
      lineHeight: 1.1,
      backgroundColor: "#FFFFFFCC",
    });
  });

  it("moves text through a semantic intent", () => {
    const editing = createEditCommitModule({
      initialDocument: createDocument(images),
      createTextId: () => "text-1",
    });
    editing.dispatch({ type: "commit", intent: editIntents.text.add(textDraft) });

    editing.dispatch({
      type: "commit",
      intent: editIntents.text.move("text-1", { x: 160, y: 240 }),
    });

    expect(editing.read().document.textElements[0]?.position).toEqual({ x: 160, y: 240 });
  });

  it("removes text and reports the removed document entity", () => {
    const editing = createEditCommitModule({
      initialDocument: createDocument(images),
      createTextId: () => "text-1",
    });
    editing.dispatch({ type: "commit", intent: editIntents.text.add(textDraft) });

    const result = editing.dispatch({ type: "commit", intent: editIntents.text.remove("text-1") });

    expect(result).toMatchObject({
      status: "changed",
      effects: { created: [], removed: [{ kind: "text", id: "text-1" }] },
    });
    expect(editing.read().document.textElements).toEqual([]);
  });

  it("reports entity effects when undo and redo add or remove text", () => {
    const editing = createEditCommitModule({
      initialDocument: createDocument(images),
      createTextId: () => "text-1",
    });
    editing.dispatch({ type: "commit", intent: editIntents.text.add(textDraft) });

    const undone = editing.dispatch({ type: "undo" });
    const redone = editing.dispatch({ type: "redo" });

    expect(undone).toMatchObject({
      status: "changed",
      effects: { created: [], removed: [{ kind: "text", id: "text-1" }] },
    });
    expect(redone).toMatchObject({
      status: "changed",
      effects: { created: [{ kind: "text", id: "text-1" }], removed: [] },
    });
  });

  it("cancels an active preview without creating an edit commit", () => {
    const autosaved = jest.fn();
    const editing = createEditCommitModule({
      initialDocument: createEmptyDocument(),
      onEditCommit: autosaved,
    });
    editing.dispatch({
      type: "preview",
      intent: editIntents.stitch.changeSpacing(18),
    });

    const result = editing.dispatch({ type: "cancel-preview" });

    expect(result).toEqual({ status: "unchanged" });
    expect(editing.read().previewDocument).toBe(editing.read().document);
    expect(editing.read()).toMatchObject({ canUndo: false, revision: 0 });
    expect(autosaved).not.toHaveBeenCalled();
  });

  it("removes text when a replacement draft has empty content", () => {
    const editing = createEditCommitModule({
      initialDocument: createDocument(images),
      createTextId: () => "text-1",
    });
    editing.dispatch({ type: "commit", intent: editIntents.text.add(textDraft) });

    const result = editing.dispatch({
      type: "commit",
      intent: editIntents.text.replaceDraft("text-1", { ...textDraft, content: "" }),
    });

    expect(result).toMatchObject({
      status: "changed",
      effects: { created: [], removed: [{ kind: "text", id: "text-1" }] },
    });
    expect(editing.read().document.textElements).toEqual([]);
  });

  it("rejects an intent for a missing entity without discarding the active preview", () => {
    const editing = createEditCommitModule({ initialDocument: createEmptyDocument() });
    editing.dispatch({
      type: "preview",
      intent: editIntents.stitch.changeSpacing(18),
    });
    const before = editing.read();

    const result = editing.dispatch({
      type: "commit",
      intent: editIntents.text.move("missing", { x: 10, y: 20 }),
    });

    expect(result).toEqual({ status: "rejected", code: "entity-not-found" });
    expect(editing.read()).toBe(before);
  });

  it("clears the redo branch after a new edit commit", () => {
    const editing = createEditCommitModule({ initialDocument: createEmptyDocument() });
    editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#111111"),
    });
    editing.dispatch({ type: "undo" });

    editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#222222"),
    });

    expect(editing.read()).toMatchObject({ canUndo: true, canRedo: false });
    expect(editing.dispatch({ type: "redo" })).toEqual({ status: "unchanged" });
    expect(editing.read().document.canvas.backgroundColor).toBe("#222222");
  });

  it("notifies subscribers after a state transition", () => {
    const editing = createEditCommitModule({ initialDocument: createEmptyDocument() });
    const listener = jest.fn();
    const unsubscribe = editing.subscribe(listener);

    editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#112233"),
    });
    unsubscribe();
    editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#223344"),
    });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("rejects reentrant dispatch from a subscriber as a programmer error", () => {
    const autosaved = jest.fn();
    const editing = createEditCommitModule({
      initialDocument: createEmptyDocument(),
      onEditCommit: autosaved,
    });
    editing.subscribe(() => {
      editing.dispatch({ type: "undo" });
    });

    expect(() =>
      editing.dispatch({
        type: "commit",
        intent: editIntents.canvas.changeBackground("#112233"),
      }),
    ).toThrow("edit dispatch must not be reentrant");
    expect(autosaved).toHaveBeenCalledWith(editing.read().document);
  });

  it("keeps only the latest forty edit commits in undo history", () => {
    const editing = createEditCommitModule({ initialDocument: createEmptyDocument() });
    for (let index = 1; index <= 41; index += 1) {
      editing.dispatch({
        type: "commit",
        intent: editIntents.canvas.changeBackground(`#${index.toString().padStart(6, "0")}`),
      });
    }

    for (let index = 0; index < 40; index += 1) {
      expect(editing.dispatch({ type: "undo" }).status).toBe("changed");
    }

    expect(editing.read().document.canvas.backgroundColor).toBe("#000001");
    expect(editing.dispatch({ type: "undo" })).toEqual({ status: "unchanged" });
  });

  it("rejects a duplicate module-owned text identity", () => {
    const editing = createEditCommitModule({
      initialDocument: createDocument(images),
      createTextId: () => "text-1",
    });
    editing.dispatch({ type: "commit", intent: editIntents.text.add(textDraft) });
    const before = editing.read();

    const result = editing.dispatch({ type: "commit", intent: editIntents.text.add(textDraft) });

    expect(result).toEqual({ status: "rejected", code: "duplicate-entity" });
    expect(editing.read()).toBe(before);
  });

  it("rejects an image order that is not an exact permutation", () => {
    const editing = createEditCommitModule({ initialDocument: createDocument(images) });
    const before = editing.read();

    const result = editing.dispatch({
      type: "commit",
      intent: editIntents.stitch.reorderImages(["image-1", "image-1"]),
    });

    expect(result).toEqual({ status: "rejected", code: "invalid-order" });
    expect(editing.read()).toBe(before);
  });

  it("rejects invalid intent values reported by document validation", () => {
    const editing = createEditCommitModule({
      initialDocument: createDocument(images),
      createTextId: () => "text-1",
    });
    editing.dispatch({ type: "commit", intent: editIntents.text.add(textDraft) });
    const before = editing.read();

    const result = editing.dispatch({
      type: "commit",
      intent: editIntents.text.move("text-1", { x: Number.NaN, y: 20 }),
    });

    expect(result).toEqual({ status: "rejected", code: "invalid-value" });
    expect(editing.read()).toBe(before);
  });
});
