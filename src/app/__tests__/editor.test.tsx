import "@/i18n";

import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";

import {
  createDocument,
  importedAssetId,
  type PlogDocument,
  type SourceImage,
} from "@/core/document";
import { createEditCommitModule } from "@/core/editing";
import { documentToRenderScene } from "@/render/scene";
import { exportDocument } from "@/services/export";
import { SKIA_EXPORT_CAPABILITIES } from "@/services/export/capabilities";
import type { ExportResult } from "@/services/export/pipeline";
import { draftId, type AssetCatalogSnapshot } from "@/services/drafts/draftLibrary";
import { editorRuntime } from "@/features/editor/expoEditorRuntime";

import RootLayout from "../_layout";
import EditorScreen from "../editor";

const mockReplace = jest.fn();
const mockBack = jest.fn();
const mockDispatch = jest.fn();
const mockRouter = { replace: mockReplace, back: mockBack };
let mockPreventRemove = false;
let mockPreventRemoveCallback:
  ((options: { data: { action: { type: string } } }) => void) | undefined;

jest.mock("expo-router", () => ({
  Stack: Object.assign(() => null, { Screen: () => null }),
  useRouter: () => mockRouter,
  useNavigation: () => ({
    dispatch: mockDispatch,
  }),
}));

jest.mock("expo-router/react-navigation", () => ({
  usePreventRemove: (preventRemove: boolean, callback: typeof mockPreventRemoveCallback) => {
    mockPreventRemove = preventRemove;
    mockPreventRemoveCallback = callback;
  },
}));

jest.mock("react-native-gesture-handler", () => ({
  GestureHandlerRootView: "GestureHandlerRootView",
}));

jest.mock("@/features/editor/expoEditorRuntime", () => ({
  editorRuntime: {
    prepareEditor: jest.fn(),
    takeImportErrorCount: jest.fn(() => 0),
    flush: jest.fn(),
  },
}));

jest.mock("@/features/editor/components/DocumentCanvas", () => ({
  DocumentCanvas: () => null,
}));

jest.mock("@/features/editor/components/TextGestureOverlay", () => ({
  TextGestureOverlay: () => null,
}));

jest.mock("@/features/editor/components/SpacingSlider", () => ({
  SpacingSlider: ({
    onCommit,
    onPreview,
    testID,
    value,
  }: {
    readonly onCommit: (value: number) => void;
    readonly onPreview: (value: number) => void;
    readonly testID: string;
    readonly value: number;
  }) => {
    const React = jest.requireActual<typeof import("react")>("react");
    const { Pressable, Text, View } =
      jest.requireActual<typeof import("react-native")>("react-native");
    return React.createElement(
      View,
      null,
      React.createElement(Text, { testID: `${testID}-value` }, `${value}`),
      React.createElement(Pressable, {
        accessibilityLabel: "Simulate spacing drag",
        accessibilityRole: "adjustable",
        onPress: () => {
          onPreview(12);
          onPreview(20);
          onCommit(20);
        },
        testID,
      }),
    );
  },
}));

jest.mock("@/render/deviceTextLayout", () => ({
  getDeviceTextLayoutEnvironment: () => ({}),
}));

jest.mock("@/features/editor/useTextLayoutSnapshot", () => ({
  useTextLayoutSnapshot: () => ({ snapshot: null }),
}));

jest.mock("@/services/export", () => ({
  exportDocument: jest.fn(),
  SKIA_EXPORT_CAPABILITIES: jest.requireActual("@/services/export/capabilities")
    .SKIA_EXPORT_CAPABILITIES,
}));

jest.mock("@/services/export/expoStaging", () => ({
  initializeExpoExportStaging: jest.fn(async () => undefined),
}));

const runtime = editorRuntime as unknown as jest.Mocked<
  Pick<typeof editorRuntime, "prepareEditor" | "takeImportErrorCount" | "flush">
>;
const mockExportDocument = exportDocument as jest.MockedFunction<typeof exportDocument>;

interface PreparedEditorOptions {
  readonly sourceImages?: readonly Pick<SourceImage, "width" | "height">[];
  readonly initialDocument?: PlogDocument;
}

function createPreparedEditor({
  sourceImages = [{ width: 100, height: 100 }],
  initialDocument,
}: PreparedEditorOptions = {}) {
  const images = sourceImages.map(({ width, height }, index) => ({
    id: importedAssetId(`image:editor-test-${index + 1}`),
    width,
    height,
  }));
  const document = initialDocument ?? createDocument(images);
  let textSequence = 0;
  const editing = createEditCommitModule({
    initialDocument: document,
    createTextId: () => `text-${++textSequence}`,
    exportCapabilities: SKIA_EXPORT_CAPABILITIES,
  });
  const imageIds = document.sourceImages.map(({ id }) => id);
  const assets: AssetCatalogSnapshot = Object.freeze({
    entries: Object.freeze(imageIds),
    resolve: (
      assetId: Parameters<AssetCatalogSnapshot["resolve"]>[0],
      usage: Parameters<AssetCatalogSnapshot["resolve"]>[1],
    ) =>
      imageIds.includes(assetId)
        ? Object.freeze({
            draftId: draftId("draft:editor-test"),
            assetId,
            usage,
            uri: `memory://${usage}`,
          })
        : null,
  });
  return { status: "prepared" as const, editing, assets };
}

async function renderPreparedEditor(prepared = createPreparedEditor()) {
  runtime.prepareEditor.mockResolvedValue(prepared);
  const view = await render(<EditorScreen />);
  await waitFor(() => expect(view.getByTestId("editor-screen")).toBeTruthy());
  return { prepared, view };
}

function successfulExportResult() {
  const presetId = createDocument().exportSettings.presetId;
  return {
    status: "success" as const,
    assetId: "photos-asset-1",
    output: { width: 1000, height: 1000, wasReduced: false, format: "jpeg" as const },
    diagnostics: {
      presetId,
      presetRevision: 1,
      catalogSchemaVersion: 1,
      backend: { id: "skia", revision: 1 },
    },
  } satisfies ExportResult;
}

type RenderedView = Awaited<ReturnType<typeof render>>;

async function press(view: RenderedView, testID: string) {
  await act(async () => {
    fireEvent.press(view.getByTestId(testID));
  });
}

async function changeText(view: RenderedView, value: string) {
  await act(async () => {
    fireEvent.changeText(view.getByTestId("text-input"), value);
  });
}

beforeEach(() => {
  runtime.takeImportErrorCount.mockReturnValue(0);
  runtime.flush.mockResolvedValue({ status: "flushed" });
});

describe("Editor behavior scenarios", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPreventRemove = false;
    mockPreventRemoveCallback = undefined;
  });

  it("[F01-S02] keeps two independently selectable text blocks after adding them", async () => {
    const { prepared, view } = await renderPreparedEditor();

    await press(view, "editor-tool-text");
    await changeText(view, "周末的海边日记");
    await press(view, "commit-text");
    await press(view, "select-new-text");
    await changeText(view, "傍晚沿着海岸散步");
    await press(view, "commit-text");

    expect(prepared.editing.read().document.textElements).toMatchObject([
      { id: "text-1", content: "周末的海边日记" },
      { id: "text-2", content: "傍晚沿着海岸散步" },
    ]);
    expect(view.getByTestId("select-text-text-1")).toHaveTextContent("周末的海边日记");
    expect(view.getByTestId("select-text-text-2")).toHaveTextContent("傍晚沿着海岸散步");
    expect(view.getByTestId("select-text-text-2")).toHaveProp("accessibilityState", {
      selected: true,
    });

    await press(view, "select-text-text-1");
    expect(view.getByTestId("select-text-text-1")).toHaveProp("accessibilityState", {
      selected: true,
    });
  });

  it("[F01-S03] updates an existing text block without creating a duplicate", async () => {
    const { prepared, view } = await renderPreparedEditor();

    await press(view, "editor-tool-text");
    await changeText(view, "修改前的文字");
    await press(view, "commit-text");
    await changeText(view, "修改后的文字");
    await press(view, "commit-text");

    expect(prepared.editing.read().document.textElements).toMatchObject([
      { id: "text-1", content: "修改后的文字" },
    ]);
    expect(view.getByTestId("select-text-text-1")).toHaveTextContent("修改后的文字");
    expect(view.queryByText("修改前的文字")).toBeNull();
  });

  it("[F01-S09] keeps independent font-size and line-height adjustments after applying a preset", async () => {
    const { prepared, view } = await renderPreparedEditor();

    await press(view, "editor-tool-text");
    await changeText(view, "标题样式");
    await press(view, "commit-text");
    await press(view, "text-preset-headline");
    await press(view, "text-size-increase");
    await press(view, "text-line-height-increase");

    expect(prepared.editing.read().document.textElements[0]).toMatchObject({
      content: "标题样式",
      fontSize: 68,
      lineHeight: 1.15,
    });
    expect(view.getByText("68")).toBeTruthy();
    expect(view.getByText("1.15")).toBeTruthy();
    expect(view.getByTestId("text-preset-custom")).toHaveProp("accessibilityState", {
      checked: true,
    });
  });

  it("[F02-S03] restores the source image aspect ratio after switching away from 3:4", async () => {
    const prepared = createPreparedEditor({ sourceImages: [{ width: 1200, height: 900 }] });
    const { view } = await renderPreparedEditor(prepared);

    await press(view, "canvas-ratio-3:4");
    expect(prepared.editing.read().document.canvas.ratio).toBe("3:4");
    expect(documentToRenderScene(prepared.editing.read().document)).toMatchObject({
      width: 1000,
      height: 1000 * (4 / 3),
    });
    expect(view.getByTestId("canvas-ratio-3:4")).toHaveProp("accessibilityState", {
      checked: true,
    });

    await press(view, "canvas-ratio-original");

    expect(prepared.editing.read().document.canvas.ratio).toBe("original");
    expect(documentToRenderScene(prepared.editing.read().document)).toMatchObject({
      width: 1000,
      height: 750,
    });
    expect(view.getByTestId("canvas-ratio-original")).toHaveProp("accessibilityState", {
      checked: true,
    });
  });

  it("[F05-S03] treats continuous spacing previews as one undoable edit commit", async () => {
    const { prepared, view } = await renderPreparedEditor();

    await press(view, "editor-tool-stitch");
    await press(view, "stitch-spacing");

    expect(prepared.editing.read().document.stitch.spacing).toBe(20);
    expect(prepared.editing.read().revision).toBe(1);
    expect(view.getByTestId("stitch-spacing-value")).toHaveTextContent("20");
    await press(view, "editor-undo");
    expect(prepared.editing.read().document.stitch.spacing).toBe(0);
    expect(view.getByTestId("stitch-spacing-value")).toHaveTextContent("0");
    expect(view.getByTestId("editor-undo")).toHaveProp("accessibilityState", {
      disabled: true,
    });
  });

  it("[F05-S05] starts with undo disabled and enables it after an edit commit", async () => {
    const { view } = await renderPreparedEditor();

    expect(view.getByTestId("editor-undo")).toBeDisabled();
    expect(view.getByTestId("editor-undo")).toHaveProp("accessibilityState", {
      disabled: true,
    });

    await press(view, "background-color-242321");

    expect(view.getByTestId("editor-undo")).toBeEnabled();
    expect(view.getByTestId("editor-undo")).toHaveProp("accessibilityState", {
      disabled: false,
    });
  });

  it("[F06-S06] keeps the active edit complete across a background flush and return", async () => {
    const appStateListeners: ((state: AppStateStatus) => void)[] = [];
    const addEventListener = jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation((event, listener) => {
        if (event === "change") appStateListeners.push(listener);
        return { remove: jest.fn() };
      });
    await render(<RootLayout />);
    const { prepared, view } = await renderPreparedEditor();
    await press(view, "editor-tool-text");
    await changeText(view, "后台返回仍保留的编辑");
    await press(view, "commit-text");
    const appStateListener = appStateListeners[0];
    if (appStateListener === undefined) throw new Error("expected AppState listener");

    await act(async () => {
      appStateListener("background");
      await Promise.resolve();
    });
    appStateListener("active");

    expect(runtime.flush).toHaveBeenCalledTimes(1);
    expect(prepared.editing.read().document.textElements).toMatchObject([
      { id: "text-1", content: "后台返回仍保留的编辑" },
    ]);
    expect(view.getByTestId("text-input")).toHaveProp("value", "后台返回仍保留的编辑");
    expect(view.getByTestId("select-text-text-1")).toHaveProp("accessibilityState", {
      selected: true,
    });
    addEventListener.mockRestore();
  });

  it("[F04-S08] continues editing and exports the updated document after an earlier success", async () => {
    mockExportDocument.mockResolvedValue(successfulExportResult());
    const { view } = await renderPreparedEditor();

    await press(view, "editor-tool-text");
    await changeText(view, "第一次导出的文字");
    await press(view, "commit-text");
    await press(view, "editor-open-export");
    await press(view, "export-document");
    await waitFor(() => expect(view.getByTestId("export-success")).toBeTruthy());

    await press(view, "editor-tool-text");
    await changeText(view, "继续编辑后的文字");
    await press(view, "commit-text");
    await press(view, "editor-open-export");
    await press(view, "export-document");

    await waitFor(() => expect(mockExportDocument).toHaveBeenCalledTimes(2));
    expect(mockExportDocument.mock.calls[0]?.[0].textElements).toMatchObject([
      { content: "第一次导出的文字" },
    ]);
    expect(mockExportDocument.mock.calls[1]?.[0].textElements).toMatchObject([
      { content: "继续编辑后的文字" },
    ]);
    expect(view.getByTestId("editor-screen")).toBeTruthy();
  });

  it("exports without creating an edit revision or flushing the Draft", async () => {
    mockExportDocument.mockResolvedValue(successfulExportResult());
    const { prepared, view } = await renderPreparedEditor();
    const before = prepared.editing.read();

    await press(view, "editor-open-export");
    await press(view, "export-document");
    await waitFor(() => expect(view.getByTestId("export-success")).toBeTruthy());

    expect(mockExportDocument).toHaveBeenCalledWith(before.document, prepared.assets);
    expect(prepared.editing.read()).toMatchObject({
      document: before.document,
      revision: before.revision,
    });
    expect(runtime.flush).not.toHaveBeenCalled();
  });

  it("[F07-S04] shows the successful photo count and partial-import warning together", async () => {
    runtime.takeImportErrorCount.mockReturnValueOnce(1);
    const prepared = createPreparedEditor({
      sourceImages: [
        { width: 1200, height: 900 },
        { width: 900, height: 1200 },
      ],
    });
    const { view } = await renderPreparedEditor(prepared);

    expect(view.getByTestId("import-warning")).toHaveTextContent(
      "Some photos could not be imported. The completed photos are ready.",
    );
    expect(view.getByText("2 photos")).toBeTruthy();
  });
});

describe("Editor session leave", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPreventRemove = false;
    mockPreventRemoveCallback = undefined;
  });

  it("[F06-S09] stays in the editor after a flush failure and navigates after retry succeeds", async () => {
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
    expect(mockBack).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(view.getByTestId("editor-back"));
    });

    expect(runtime.flush).toHaveBeenCalledTimes(2);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it("prevents native removal until the latest document flushes", async () => {
    runtime.prepareEditor.mockResolvedValue(createPreparedEditor());
    runtime.flush.mockResolvedValueOnce({
      status: "flush-failed",
      reason: "storage-failed",
    });
    runtime.flush.mockResolvedValueOnce({ status: "flushed" });
    const view = await render(<EditorScreen />);
    await waitFor(() => expect(view.getByTestId("editor-back")).toBeTruthy());
    const action = { type: "GO_BACK" };
    expect(mockPreventRemove).toBe(true);

    await act(async () => {
      mockPreventRemoveCallback?.({ data: { action } });
    });

    expect(view.getByTestId("editor-save-error")).toBeTruthy();
    expect(mockPreventRemove).toBe(true);
    expect(mockDispatch).not.toHaveBeenCalled();

    await act(async () => {
      mockPreventRemoveCallback?.({ data: { action } });
    });

    expect(runtime.flush).toHaveBeenCalledTimes(2);
    expect(mockPreventRemove).toBe(false);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith(action);
  });
});

describe("Editor preparation failure", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPreventRemove = false;
    mockPreventRemoveCallback = undefined;
  });

  it("keeps a preview failure in a retryable Editor state until the user goes back", async () => {
    runtime.prepareEditor.mockResolvedValue({
      status: "preview-failed",
      reason: "preview-unavailable",
      message: "decode failed",
    });
    const view = await render(<EditorScreen />);

    await waitFor(() => expect(view.getByTestId("editor-prepare-error")).toBeTruthy());
    expect(view.getByTestId("editor-prepare-error-message")).toHaveTextContent(
      "We couldn't prepare the photo previews. Your draft is unchanged.",
    );
    expect(mockReplace).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(view.getByTestId("retry-editor-preparation"));
    });
    await waitFor(() => expect(runtime.prepareEditor).toHaveBeenCalledTimes(2));

    fireEvent.press(view.getByTestId("leave-editor-preparation"));
    expect(mockReplace).toHaveBeenCalledWith("/");
  });

  it("shows the same retryable state when preparation throws unexpectedly", async () => {
    runtime.prepareEditor.mockRejectedValue(new Error("unexpected decode error"));

    const view = await render(<EditorScreen />);

    await waitFor(() => expect(view.getByTestId("editor-prepare-error")).toBeTruthy());
    expect(view.getByTestId("retry-editor-preparation")).toHaveProp(
      "accessibilityLabel",
      "Try again",
    );
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
