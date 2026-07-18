import { render, waitFor } from "@testing-library/react-native";

import { initializeExpoExportStaging } from "@/services/export/expoStaging";

import RootLayout from "../_layout";

jest.mock("expo-router", () => ({
  Stack: () => null,
}));

jest.mock("react-native-gesture-handler", () => ({
  GestureHandlerRootView: "GestureHandlerRootView",
}));

jest.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: "SafeAreaProvider",
}));

jest.mock("@/features/editor/expoEditorRuntime", () => ({
  editorRuntime: {
    flush: jest.fn(),
  },
}));

jest.mock("@/services/export/expoStaging", () => ({
  initializeExpoExportStaging: jest.fn(async () => undefined),
}));

const initializeStaging = initializeExpoExportStaging as jest.MockedFunction<
  typeof initializeExpoExportStaging
>;

describe("app startup maintenance", () => {
  it("starts export staging recovery from the root layout", async () => {
    render(<RootLayout />);

    await waitFor(() => expect(initializeStaging).toHaveBeenCalledTimes(1));
  });
});
