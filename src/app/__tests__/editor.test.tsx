import "@/i18n";

import { act, fireEvent, render, waitFor } from "@testing-library/react-native";

import { editorRuntime } from "@/features/editor/expoEditorRuntime";

import EditorScreen from "../editor";

const mockReplace = jest.fn();
const mockRouter = { push: jest.fn(), replace: mockReplace };

jest.mock("@/features/editor/expoEditorRuntime", () => ({
  editorRuntime: {
    prepareEditor: jest.fn(),
    takeImportErrorCount: jest.fn(() => 0),
    readBasicMetadata: jest.fn(),
    flush: jest.fn(),
  },
}));

jest.mock("@/features/editor/components/StitchPanel", () => ({
  StitchPanel: () => null,
}));

jest.mock("@/features/editor/components/TextGestureOverlay", () => ({
  TextGestureOverlay: () => null,
}));

jest.mock("@/features/editor/components/DocumentCanvas", () => ({
  DocumentCanvas: () => null,
}));

jest.mock("@/render/deviceTextLayout", () => ({
  getDeviceTextLayoutEnvironment: jest.fn(),
}));

jest.mock("@/services/export", () => ({
  exportDocument: jest.fn(),
  SKIA_EXPORT_CAPABILITIES: {},
}));

jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
}));

const runtime = editorRuntime as unknown as jest.Mocked<
  Pick<typeof editorRuntime, "prepareEditor">
>;

describe("Editor preparation failure", () => {
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
