import "@/i18n";

import { act, fireEvent, render, waitFor } from "@testing-library/react-native";

import { createDocument, importedAssetId } from "@/core/document";
import { createEditCommitModule } from "@/core/editing";
import { SKIA_EXPORT_CAPABILITIES } from "@/services/export/capabilities";
import { draftId, type AssetCatalogSnapshot } from "@/services/drafts/draftLibrary";
import { editorRuntime } from "@/features/editor/expoEditorRuntime";

import EditorScreen from "../editor";

const mockReplace = jest.fn();
const mockDispatch = jest.fn();
let mockBeforeRemove:
  | ((event: {
      preventDefault: () => void;
      data: { action: { type: string } };
    }) => void)
  | undefined;

jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ replace: mockReplace }),
  useNavigation: () => ({
    addListener: (_type: string, listener: typeof mockBeforeRemove) => {
      mockBeforeRemove = listener;
      return jest.fn();
    },
    dispatch: mockDispatch,
  }),
}));

jest.mock("@/features/editor/expoEditorRuntime", () => ({
  editorRuntime: {
    prepareEditor: jest.fn(),
    takeImportErrorCount: jest.fn(() => 0),
    flush: jest.fn(),
    readBasicMetadata: jest.fn(),
  },
}));

jest.mock("@/features/editor/components/DocumentCanvas", () => ({
  DocumentCanvas: () => null,
}));

jest.mock("@/features/editor/components/TextGestureOverlay", () => ({
  TextGestureOverlay: () => null,
}));

jest.mock("@/features/editor/components/BackgroundPanel", () => ({
  BackgroundPanel: () => null,
}));

jest.mock("@/features/editor/components/EditorToolbar", () => ({
  EditorToolbar: () => null,
}));

jest.mock("@/features/editor/components/ExportPanel", () => ({
  ExportPanel: () => null,
}));

jest.mock("@/features/editor/components/StitchPanel", () => ({
  StitchPanel: () => null,
}));

jest.mock("@/features/editor/components/TextPanel", () => ({
  TextPanel: () => null,
}));

jest.mock("@/render/deviceTextLayout", () => ({
  getDeviceTextLayoutEnvironment: () => ({}),
}));

jest.mock("@/features/editor/useTextLayoutSnapshot", () => ({
  useTextLayoutSnapshot: () => ({ snapshot: null }),
}));

jest.mock("@/services/export", () => ({
  exportDocument: jest.fn(),
  SKIA_EXPORT_CAPABILITIES:
    jest.requireActual("@/services/export/capabilities").SKIA_EXPORT_CAPABILITIES,
}));

const runtime = editorRuntime as unknown as jest.Mocked<
  Pick<
    typeof editorRuntime,
    "prepareEditor" | "takeImportErrorCount" | "flush" | "readBasicMetadata"
  >
>;

function createPreparedEditor() {
  const imageId = importedAssetId("image:editor-test");
  const document = createDocument([{ id: imageId, width: 100, height: 100 }]);
  const editing = createEditCommitModule({
    initialDocument: document,
    exportCapabilities: SKIA_EXPORT_CAPABILITIES,
  });
  const assets: AssetCatalogSnapshot = Object.freeze({
    entries: Object.freeze([imageId]),
    resolve: (
      assetId: Parameters<AssetCatalogSnapshot["resolve"]>[0],
      usage: Parameters<AssetCatalogSnapshot["resolve"]>[1],
    ) =>
      assetId === imageId
        ? Object.freeze({
            draftId: draftId("draft:editor-test"),
            assetId,
            usage,
            uri: `memory://${usage}`,
          })
        : null,
  });
  return { editing, assets };
}

describe("Editor session leave", () => {
  beforeEach(() => {
    mockBeforeRemove = undefined;
  });

  it("stays in the editor after a flush failure and navigates after retry succeeds", async () => {
    runtime.prepareEditor.mockResolvedValue(createPreparedEditor());
    runtime.flush.mockResolvedValueOnce({
      status: "flush-failed",
      reason: "storage-failed",
      message: "disk full",
    });
    runtime.flush.mockResolvedValueOnce({ status: "flushed" });
    const view = await render(<EditorScreen />);
    await waitFor(() => expect(view.getByTestId("editor-back")).toBeTruthy());

    await act(async () => {
      fireEvent.press(view.getByTestId("editor-back"));
    });

    expect(view.getByTestId("editor-save-error")).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(view.getByTestId("editor-back"));
    });

    expect(runtime.flush).toHaveBeenCalledTimes(2);
    expect(mockReplace).toHaveBeenCalledWith("/");
  });

  it("applies the same flush guard to system and gesture removal", async () => {
    runtime.prepareEditor.mockResolvedValue(createPreparedEditor());
    runtime.flush.mockResolvedValueOnce({
      status: "flush-failed",
      reason: "storage-failed",
    });
    runtime.flush.mockResolvedValueOnce({ status: "flushed" });
    const view = await render(<EditorScreen />);
    await waitFor(() => expect(view.getByTestId("editor-back")).toBeTruthy());
    const action = { type: "GO_BACK" };
    const preventDefault = jest.fn();

    await act(async () => {
      mockBeforeRemove?.({ preventDefault, data: { action } });
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(view.getByTestId("editor-save-error")).toBeTruthy();
    expect(mockDispatch).not.toHaveBeenCalled();

    await act(async () => {
      mockBeforeRemove?.({ preventDefault, data: { action } });
    });

    expect(runtime.flush).toHaveBeenCalledTimes(2);
    expect(mockDispatch).toHaveBeenCalledWith(action);
  });
});
