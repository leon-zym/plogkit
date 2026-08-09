import "@/i18n";

import { act, fireEvent, render, waitFor } from "@testing-library/react-native";

import type { AppSettingsState, AppSettingsUpdateResult } from "@/services/settings/appSettings";
import { appSettings } from "@/services/settings/expoAppSettings";

import SettingsScreen from "../settings";

const mockBack = jest.fn();
let state: AppSettingsState;
let listener: (() => void) | null;

jest.mock("@/services/settings/expoAppSettings", () => ({
  appSettings: {
    initialize: jest.fn(),
    getState: jest.fn(),
    subscribe: jest.fn(),
    setDefaultMetadataPolicy: jest.fn(),
    setDraftThumbnailDisplay: jest.fn(),
  },
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ back: mockBack }),
}));

const settings = appSettings as unknown as {
  initialize: jest.Mock;
  getState: jest.Mock;
  subscribe: jest.Mock;
  setDefaultMetadataPolicy: jest.Mock;
  setDraftThumbnailDisplay: jest.Mock;
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("Settings screen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBack.mockClear();
    listener = null;
    state = {
      status: "ready",
      settings: {
        defaultMetadataPolicy: "strip",
        draftThumbnailDisplay: "square",
      },
    };
    settings.getState.mockImplementation(() => state);
    settings.subscribe.mockImplementation((next: () => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    });
    settings.initialize.mockImplementation(async () => state);
    settings.setDefaultMetadataPolicy.mockResolvedValue({
      status: "saved",
      settings: state.settings,
    });
  });

  it("renders the authoritative module snapshot and starts initialization", async () => {
    state = {
      status: "ready",
      settings: {
        defaultMetadataPolicy: "retain-basic",
        draftThumbnailDisplay: "original",
      },
    };

    const view = await render(<SettingsScreen />);

    expect(view.getByTestId("settings-retain-basic").props.value).toBe(true);
    await waitFor(() => expect(settings.initialize).toHaveBeenCalledTimes(1));
  });

  it("[F09-S04] keeps the old value and disables the control until persistence succeeds", async () => {
    const pending = deferred<AppSettingsUpdateResult>();
    settings.setDefaultMetadataPolicy.mockReturnValueOnce(pending.promise);
    const view = await render(<SettingsScreen />);

    await act(async () => {
      fireEvent(view.getByTestId("settings-retain-basic"), "valueChange", true);
    });

    await waitFor(() => {
      expect(view.getByTestId("settings-retain-basic").props.disabled).toBe(true);
    });
    expect(view.getByTestId("settings-retain-basic").props.value).toBe(false);

    const snapshot = Object.freeze({
      defaultMetadataPolicy: "retain-basic" as const,
      draftThumbnailDisplay: "square" as const,
    });
    state = { status: "ready", settings: snapshot };
    await act(async () => {
      listener?.();
      pending.resolve({ status: "saved", settings: snapshot });
    });

    await waitFor(() => {
      expect(view.getByTestId("settings-retain-basic").props.disabled).toBe(false);
      expect(view.getByTestId("settings-retain-basic").props.value).toBe(true);
    });
  });

  it("[F09-S05] shows a localized error and preserves the old value after save failure", async () => {
    settings.setDefaultMetadataPolicy.mockResolvedValueOnce({
      status: "save-failed",
      settings: state.settings,
    });
    const view = await render(<SettingsScreen />);

    await act(async () => {
      fireEvent(view.getByTestId("settings-retain-basic"), "valueChange", true);
    });

    await waitFor(() =>
      expect(view.getByTestId("settings-error")).toHaveTextContent(
        "The setting could not be saved. Try again.",
      ),
    );
    expect(view.getByTestId("settings-retain-basic").props.value).toBe(false);
    expect(view.getByTestId("settings-retain-basic").props.disabled).toBe(false);
  });

  it("[F09-S07] disables settings after a load failure and offers initialization retry", async () => {
    state = {
      status: "load-failed",
      settings: {
        defaultMetadataPolicy: "strip",
        draftThumbnailDisplay: "square",
      },
    };
    const view = await render(<SettingsScreen />);
    await waitFor(() => expect(settings.initialize).toHaveBeenCalledTimes(1));

    expect(view.getByTestId("settings-retain-basic").props.disabled).toBe(true);
    expect(view.getByTestId("settings-error")).toHaveTextContent(
      "Settings could not be read from this device.",
    );
    fireEvent.press(view.getByTestId("retry-app-settings"));

    expect(settings.initialize).toHaveBeenCalledTimes(2);
  });
});
