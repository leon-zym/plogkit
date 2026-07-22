import "@/i18n";

import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { FlatList } from "react-native";

import { editorRuntime } from "@/features/editor/expoEditorRuntime";
import { draftId, type DraftLibraryState } from "@/services/drafts/draftLibrary";
import { settingsRuntime } from "@/services/settings/expoSettingsRuntime";

import HomeScreen from "../index";

const mockPush = jest.fn();
const firstId = draftId("draft:1");
const corruptId = draftId("draft:corrupt");
let state: DraftLibraryState;
let listener: (() => void) | null;

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

jest.mock("@/services/settings/expoSettingsRuntime", () => ({
  settingsRuntime: {
    load: jest.fn(),
    save: jest.fn(),
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
const settings = settingsRuntime as unknown as {
  load: jest.Mock;
  save: jest.Mock;
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

describe("Home Draft Library", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPush.mockClear();
    listener = null;
    state = { status: "uninitialized" };
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
    settings.load.mockResolvedValue({
      schemaVersion: 2,
      defaultMetadataPolicy: "strip",
      draftThumbnailDisplay: "square",
    });
    settings.save.mockResolvedValue(undefined);
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

    expect(view.getByTestId("draft-item-0").props.accessibilityLabel).toContain(
      "Draft 1 of 2",
    );
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

    expect(settings.save).toHaveBeenCalledWith({
      schemaVersion: 2,
      defaultMetadataPolicy: "strip",
      draftThumbnailDisplay: "original",
    });
    expect(view.getByTestId("draft-thumbnail-0").props.resizeMode).toBe("contain");
    expect(view.getByTestId("draft-thumbnail-0").props.source).toEqual({
      uri: "memory://original.jpg",
    });
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
      entries: [
        { ...revised.entries[0], contentRevision: 4 },
        ...revised.entries.slice(1),
      ],
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
