import "@/i18n";

import { act, fireEvent, render, waitFor } from "@testing-library/react-native";

import { editorRuntime } from "@/features/editor/expoEditorRuntime";

import HomeScreen from "../index";

jest.mock("@/features/editor/expoEditorRuntime", () => ({
  editorRuntime: {
    restore: jest.fn(),
    choosePhotos: jest.fn(),
  },
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

const runtime = editorRuntime as unknown as jest.Mocked<
  Pick<typeof editorRuntime, "restore" | "choosePhotos">
>;

describe("Home Draft creation", () => {
  it("shows a storage failure when atomic Draft publication fails without item errors", async () => {
    runtime.restore.mockResolvedValue({ status: "none" });
    runtime.choosePhotos.mockResolvedValue({
      status: "create-failed",
      message: "publication failed",
      errors: [],
    });
    const view = await render(<HomeScreen />);
    await waitFor(() => expect(view.getByTestId("choose-photos")).toBeTruthy());

    await act(async () => {
      fireEvent.press(view.getByTestId("choose-photos"));
    });

    await waitFor(() => {
      expect(view.getByTestId("home-error")).toHaveTextContent(
        "We couldn't prepare those photos. Try choosing them again.",
      );
    });
  });
});
