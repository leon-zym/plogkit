import "@/i18n";

import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { FlatList } from "react-native";

import { editorRuntime } from "@/features/editor/expoEditorRuntime";
import { draftId, type DraftLibraryState } from "@/services/drafts/draftLibrary";
import type { AppSettingsState } from "@/services/settings/appSettings";
import { appSettings } from "@/services/settings/expoAppSettings";

import HomeScreen from "../index";

const mockPush = jest.fn();
const firstId = draftId("draft:1");
const corruptId = draftId("draft:corrupt");
let state: DraftLibraryState;
let listener: (() => void) | null;
let settingsState: AppSettingsState;
let settingsListener: (() => void) | null;

jest.mock("@/features/editor/expoEditorRuntime", () => ({
  editorRuntime: {
    loadDraftLibrary: jest.fn(),
    getDraftLibraryState: jest.fn(),
    subscribeDraftLibrary: jest.fn(),
    openDraft: jest.fn(),
    choosePhotos: jest.fn(),
    deleteDraft: jest.fn(),
    reportThumbnailLoadFailure: jest.fn(),
  },
}));

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
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));

const runtime = editorRuntime as unknown as {
  loadDraftLibrary: jest.Mock;
  getDraftLibraryState: jest.Mock;
  subscribeDraftLibrary: jest.Mock;
  openDraft: jest.Mock;
  choosePhotos: jest.Mock;
  deleteDraft: jest.Mock;
  reportThumbnailLoadFailure: jest.Mock;
};
const settings = appSettings as unknown as {
  initialize: jest.Mock;
  getState: jest.Mock;
  subscribe: jest.Mock;
  setDefaultMetadataPolicy: jest.Mock;
  setDraftThumbnailDisplay: jest.Mock;
};

function readyState(): DraftLibraryState {
  return {
    status: "ready",
    entries: [
      {
        status: "ready",
        draftId: firstId,
        createdAt: "2026-07-21T08:00:00.000Z",
        updatedAt: "2026-07-22T08:00:00.000Z",
        contentRevision: 3,
        photoCount: 2,
        thumbnailStatus: "ready",
        thumbnail: {
          contentRevision: 3,
          profileVersion: 1,
          squareUri: "memory://square.jpg",
          originalUri: "memory://original.jpg",
        },
      },
      {
        status: "corrupt",
        draftId: corruptId,
        updatedAt: null,
        photoCount: null,
        reason: "document-corrupt",
        thumbnail: null,
      },
    ],
  };
}

async function publish(next: DraftLibraryState): Promise<void> {
  state = next;
  await act(async () => listener?.());
}

async function publishSettings(next: AppSettingsState): Promise<void> {
  settingsState = next;
  await act(async () => settingsListener?.());
}

describe("Home Draft Library", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPush.mockClear();
    listener = null;
    settingsListener = null;
    state = { status: "uninitialized" };
    settingsState = {
      status: "ready",
      settings: {
        defaultMetadataPolicy: "strip",
        draftThumbnailDisplay: "square",
      },
    };
    runtime.getDraftLibraryState.mockImplementation(() => state);
    runtime.subscribeDraftLibrary.mockImplementation((next: () => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    });
    runtime.loadDraftLibrary.mockImplementation(async () => state);
    runtime.openDraft.mockResolvedValue({
      status: "opened",
      draftId: firstId,
      contentRevision: 3,
    });
    runtime.deleteDraft.mockResolvedValue({ status: "deleted" });
    settings.getState.mockImplementation(() => settingsState);
    settings.subscribe.mockImplementation((next: () => void) => {
      settingsListener = next;
      return () => {
        settingsListener = null;
      };
    });
    settings.initialize.mockImplementation(async () => settingsState);
    settings.setDraftThumbnailDisplay.mockImplementation(
      async (draftThumbnailDisplay: "square" | "original") => {
        const next = Object.freeze({
          ...settingsState.settings,
          draftThumbnailDisplay,
        });
        settingsState = { status: "ready", settings: next };
        settingsListener?.();
        return { status: "saved", settings: next };
      },
    );
  });

  it("shows the creation Banner immediately while the reliable Grid is loading", async () => {
    state = { status: "loading" };

    const view = await render(<HomeScreen />);

    expect(view.getByTestId("choose-photos")).toBeTruthy();
    expect(view.getByTestId("home-loading")).toBeTruthy();
    expect(view.queryByTestId("resume-session")).toBeNull();
    expect(view.queryByTestId("draft-item-0")).toBeNull();
    await view.unmount();
  });

  it("renders accessible thumbnail-only items and opens the exact selected Draft", async () => {
    state = readyState();
    const view = await render(<HomeScreen />);
    await waitFor(() => expect(view.getByTestId("draft-item-0")).toBeTruthy());

    expect(view.getByTestId("draft-item-0").props.accessibilityLabel).toContain("Draft 1 of 2");
    expect(view.getByTestId("draft-item-0").props.accessibilityLabel).toContain("2 photos");
    expect(view.getByTestId("draft-item-1").props.accessibilityLabel).toContain("damaged");
    expect(view.queryByText("draft:1")).toBeNull();

    await act(async () => fireEvent.press(view.getByTestId("draft-item-0")));

    expect(runtime.openDraft).toHaveBeenCalledWith(firstId);
    expect(mockPush).toHaveBeenCalledWith("/editor");
  });

  it("announces an unavailable thumbnail without claiming the Draft is ready", async () => {
    const ready = readyState();
    const first = ready.status === "ready" ? ready.entries[0] : undefined;
    if (first?.status !== "ready") throw new Error("expected a ready Draft");
    state = {
      status: "ready",
      entries: [
        { ...first, thumbnail: null, thumbnailStatus: "unavailable" },
        ...(ready.status === "ready" ? ready.entries.slice(1) : []),
      ],
    };

    const view = await render(<HomeScreen />);
    await waitFor(() => expect(view.getByTestId("draft-item-0")).toBeTruthy());

    expect(view.getByTestId("draft-item-0").props.accessibilityLabel).toContain(
      "Thumbnail is unavailable",
    );
    expect(view.getByTestId("draft-item-0").props.accessibilityLabel).not.toContain("Ready");
  });

  it("persists one global display mode and switches the whole Grid to contain", async () => {
    state = readyState();
    const view = await render(<HomeScreen />);
    await waitFor(() => expect(view.getByTestId("home-menu")).toBeTruthy());

    await act(async () => fireEvent.press(view.getByTestId("home-menu")));
    await waitFor(() => expect(view.getByTestId("display-original")).toBeTruthy());
    await act(async () => fireEvent.press(view.getByTestId("display-original")));

    expect(settings.setDraftThumbnailDisplay).toHaveBeenCalledWith("original");
    expect(view.getByTestId("draft-thumbnail-0").props.resizeMode).toBe("contain");
    expect(view.getByTestId("draft-thumbnail-0").props.source).toEqual({
      uri: "memory://original.jpg",
    });
  });

  it("keeps the old display selected and disables both choices while saving", async () => {
    state = readyState();
    let resolveSave:
      | ((value: {
          readonly status: "saved";
          readonly settings: AppSettingsState["settings"];
        }) => void)
      | null = null;
    settings.setDraftThumbnailDisplay.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    const view = await render(<HomeScreen />);

    await act(async () => fireEvent.press(view.getByTestId("home-menu")));
    await act(async () => fireEvent.press(view.getByTestId("display-original")));

    await waitFor(() =>
      expect(view.getByTestId("display-original").props.accessibilityState).toEqual(
        expect.objectContaining({ checked: false, disabled: true }),
      ),
    );
    expect(view.getByTestId("display-square").props.accessibilityState).toEqual(
      expect.objectContaining({ checked: true, disabled: true }),
    );

    const next = Object.freeze({
      defaultMetadataPolicy: "strip" as const,
      draftThumbnailDisplay: "original" as const,
    });
    settingsState = { status: "ready", settings: next };
    await act(async () => {
      settingsListener?.();
      resolveSave?.({ status: "saved", settings: next });
    });

    await waitFor(() => expect(view.queryByTestId("display-menu")).toBeNull());
    expect(view.getByTestId("draft-thumbnail-0").props.resizeMode).toBe("contain");
  });

  it("waits for authoritative settings before saving the global display mode", async () => {
    state = readyState();
    settingsState = {
      status: "loading",
      settings: {
        defaultMetadataPolicy: "strip",
        draftThumbnailDisplay: "square",
      },
    };
    const view = await render(<HomeScreen />);

    await act(async () => fireEvent.press(view.getByTestId("home-menu")));
    const original = view.getByTestId("display-original");
    expect(original.props.accessibilityState).toEqual(
      expect.objectContaining({
        checked: false,
        disabled: true,
      }),
    );
    await act(async () => fireEvent.press(original));
    expect(settings.setDraftThumbnailDisplay).not.toHaveBeenCalled();

    await publishSettings({
      status: "ready",
      settings: {
        defaultMetadataPolicy: "retain-basic",
        draftThumbnailDisplay: "square",
      },
    });
    await waitFor(() =>
      expect(view.getByTestId("display-original").props.accessibilityState).toEqual(
        expect.objectContaining({ checked: false, disabled: false }),
      ),
    );
    await act(async () => fireEvent.press(view.getByTestId("display-original")));

    expect(settings.setDraftThumbnailDisplay).toHaveBeenCalledWith("original");
  });

  it("keeps the old display selection and shows an error when saving fails", async () => {
    state = readyState();
    settings.setDraftThumbnailDisplay.mockImplementationOnce(async () => ({
      status: "save-failed",
      settings: settingsState.settings,
    }));
    const view = await render(<HomeScreen />);

    await act(async () => fireEvent.press(view.getByTestId("home-menu")));
    await act(async () => fireEvent.press(view.getByTestId("display-original")));

    expect(view.getByTestId("home-error")).toHaveTextContent(
      "The display preference could not be saved.",
    );
    expect(view.getByTestId("draft-thumbnail-0").props.resizeMode).toBe("cover");
  });

  it("scrolls to the top only when the opened Draft returns with a new content revision", async () => {
    const scrollToOffset = jest.spyOn(FlatList.prototype, "scrollToOffset");
    state = readyState();
    const view = await render(<HomeScreen />);
    await waitFor(() => expect(view.getByTestId("draft-item-0")).toBeTruthy());
    await act(async () => fireEvent.press(view.getByTestId("draft-item-0")));
    scrollToOffset.mockClear();

    await publish(readyState());
    expect(scrollToOffset).not.toHaveBeenCalled();
    const revised = readyState();
    if (revised.status !== "ready" || revised.entries[0]?.status !== "ready") {
      throw new Error("expected a ready Draft");
    }
    await publish({
      status: "ready",
      entries: [{ ...revised.entries[0], contentRevision: 4 }, ...revised.entries.slice(1)],
    });

    expect(scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: 0 });
    scrollToOffset.mockRestore();
  });

  it("requires the normal-Draft action menu and confirmation, but corrupt tap goes to confirmation", async () => {
    state = readyState();
    const view = await render(<HomeScreen />);
    await waitFor(() => expect(view.getByTestId("draft-item-0")).toBeTruthy());

    await act(async () => fireEvent(view.getByTestId("draft-item-0"), "longPress"));
    expect(view.getByTestId("delete-draft-action")).toBeTruthy();
    await act(async () => fireEvent.press(view.getByTestId("delete-draft-action")));
    expect(view.getByTestId("delete-confirmation")).toBeTruthy();
    await act(async () => fireEvent.press(view.getByTestId("cancel-delete")));

    await act(async () => fireEvent.press(view.getByTestId("draft-item-1")));
    expect(view.getByTestId("corrupt-delete-confirmation")).toBeTruthy();
    await act(async () => fireEvent.press(view.getByTestId("confirm-delete")));
    expect(runtime.deleteDraft).toHaveBeenCalledWith(corruptId);
  });

  it("replaces an unknown deletion snapshot with a page failure and retries only that decision", async () => {
    state = readyState();
    runtime.deleteDraft
      .mockResolvedValueOnce({ status: "delete-unknown" })
      .mockResolvedValueOnce({ status: "deleted" });
    const view = await render(<HomeScreen />);
    await waitFor(() => expect(view.getByTestId("draft-item-0")).toBeTruthy());
    expect(view.getByText("2")).toBeTruthy();
    await act(async () => fireEvent(view.getByTestId("draft-item-0"), "longPress"));
    await act(async () => fireEvent.press(view.getByTestId("delete-draft-action")));
    await act(async () => fireEvent.press(view.getByTestId("confirm-delete")));

    expect(view.getByTestId("home-storage-failed")).toBeTruthy();
    expect(view.queryByTestId("draft-item-0")).toBeNull();
    expect(view.queryByText("2")).toBeNull();
    await act(async () => fireEvent.press(view.getByTestId("retry-draft-deletion")));
    expect(runtime.deleteDraft).toHaveBeenNthCalledWith(2, firstId);
  });

  it("retries a page-level library read failure without displaying a stale Grid", async () => {
    state = { status: "storage-failed", message: "disk unavailable" };
    const view = await render(<HomeScreen />);
    await waitFor(() => expect(view.getByTestId("home-storage-failed")).toBeTruthy());

    await act(async () => fireEvent.press(view.getByTestId("retry-draft-library")));

    expect(runtime.loadDraftLibrary).toHaveBeenCalledTimes(2);
    await publish({ status: "ready", entries: [] });
    expect(view.queryByTestId("home-storage-failed")).toBeNull();
    expect(view.queryByTestId("draft-item-0")).toBeNull();
  });

  it("shows a creation error when the Draft publication does not commit", async () => {
    state = { status: "ready", entries: [] };
    runtime.choosePhotos.mockResolvedValue({
      status: "create-failed",
      message: "publication failed",
      errors: [],
    });
    const view = await render(<HomeScreen />);
    await waitFor(() => expect(view.getByTestId("choose-photos")).toBeTruthy());

    await act(async () => fireEvent.press(view.getByTestId("choose-photos")));

    expect(view.getByTestId("home-error")).toHaveTextContent(
      "We couldn't prepare those photos. Try choosing them again.",
    );
  });
});
