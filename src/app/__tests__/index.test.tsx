import "@/i18n";

import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { FlatList, StyleSheet, useWindowDimensions } from "react-native";

import { editorRuntime } from "@/features/editor/expoEditorRuntime";
import {
  draftId,
  type DraftLibraryState,
  type DraftListEntry,
} from "@/services/drafts/draftLibrary";
import type { AppSettingsState } from "@/services/settings/appSettings";
import { appSettings } from "@/services/settings/expoAppSettings";

import HomeScreen from "../index";

jest.mock("react-native/Libraries/Utilities/useWindowDimensions", () => ({
  __esModule: true,
  default: jest.fn(() => ({ width: 390, height: 844, scale: 3, fontScale: 1 })),
}));

const mockPush = jest.fn();
const firstId = draftId("draft:1");
const corruptId = draftId("draft:corrupt");
const mockUseWindowDimensions = useWindowDimensions as jest.MockedFunction<
  typeof useWindowDimensions
>;
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

function readyEntry(
  index: number,
  overrides: Partial<Extract<DraftListEntry, { status: "ready" }>> = {},
): Extract<DraftListEntry, { status: "ready" }> {
  return {
    status: "ready",
    draftId: draftId(`draft:fixture:${index}`),
    createdAt: new Date(Date.UTC(2026, 6, 1, 8, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 6, 1, 9, index)).toISOString(),
    contentRevision: index + 1,
    photoCount: (index % 9) + 1,
    thumbnailStatus: "ready",
    thumbnail: {
      contentRevision: index + 1,
      profileVersion: 1,
      squareUri: `memory://fixture-${index}-square.jpg`,
      originalUri: `memory://fixture-${index}-original.jpg`,
    },
    ...overrides,
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
    mockUseWindowDimensions.mockReturnValue({
      width: 390,
      height: 844,
      scale: 3,
      fontScale: 1,
    });
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

  it("[F08-S01][F08-S11] shows the creation Banner immediately while the reliable Grid is loading", async () => {
    state = { status: "loading" };

    const view = await render(<HomeScreen />);

    expect(view.getByTestId("choose-photos")).toBeTruthy();
    expect(view.getByTestId("home-loading")).toBeTruthy();
    expect(view.queryByTestId("resume-session")).toBeNull();
    expect(view.queryByTestId("draft-item-0")).toBeNull();
    await view.unmount();
  });

  it("[F08-S02] keeps a loaded empty Grid empty without duplicating the creation entry", async () => {
    state = { status: "ready", entries: [] };

    const view = await render(<HomeScreen />);

    await waitFor(() => expect(view.getByTestId("home-grid")).toBeTruthy());
    expect(view.getAllByTestId("choose-photos")).toHaveLength(1);
    expect(view.queryByTestId("home-loading")).toBeNull();
    expect(view.queryByTestId("draft-item-0")).toBeNull();
    expect(view.queryByTestId("draft-thumbnail-placeholder-0")).toBeNull();
    expect(view.queryByTestId("draft-corrupt-placeholder-0")).toBeNull();
  });

  it("[F08-S06] uses three phone columns, adds tablet columns, and passes every thumbnail to the Grid", async () => {
    const fixtures = Array.from({ length: 37 }, (_, index) => readyEntry(index));
    state = { status: "ready", entries: fixtures };
    const phone = await render(<HomeScreen />);

    expect(phone.getByTestId("draft-item-2").parent).toBe(phone.getByTestId("draft-item-0").parent);
    expect(phone.getByTestId("draft-item-3").parent).not.toBe(
      phone.getByTestId("draft-item-0").parent,
    );
    expect(phone.getByText("37")).toBeTruthy();
    expect(phone.getByTestId("draft-item-29").props.accessibilityLabel).toContain("Draft 30 of 37");
    expect(phone.getByTestId("draft-thumbnail-0").props.source).toEqual({
      uri: "memory://fixture-0-square.jpg",
    });
    const phoneItemStyle = StyleSheet.flatten(phone.getByTestId("draft-item-0").props.style);
    expect(phoneItemStyle.width).toBe(phoneItemStyle.height);
    expect(phoneItemStyle.borderWidth).toBeUndefined();
    expect(phone.queryByText("draft:fixture:0")).toBeNull();
    expect(phone.queryByText(fixtures[0]!.updatedAt)).toBeNull();
    await phone.unmount();

    mockUseWindowDimensions.mockReturnValue({
      width: 1024,
      height: 1366,
      scale: 2,
      fontScale: 1,
    });
    state = { status: "ready", entries: fixtures.slice(0, 8) };
    const tablet = await render(<HomeScreen />);

    expect(tablet.getByTestId("draft-item-6").parent).toBe(
      tablet.getByTestId("draft-item-0").parent,
    );
    expect(tablet.getByTestId("draft-item-7").parent).not.toBe(
      tablet.getByTestId("draft-item-0").parent,
    );
    const tabletItemStyle = StyleSheet.flatten(tablet.getByTestId("draft-item-0").props.style);
    expect(tabletItemStyle.width).toBe(tabletItemStyle.height);
  });

  it("[F08-S18][F08-S32] renders accessible thumbnail-only items and opens the exact selected Draft", async () => {
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

  it("[F08-S32] announces an unavailable thumbnail without claiming the Draft is ready", async () => {
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

  it("[F08-S17] shows the previous complete thumbnail or a neutral placeholder without using an original", async () => {
    state = {
      status: "ready",
      entries: [
        readyEntry(0, {
          contentRevision: 2,
          thumbnail: {
            contentRevision: 1,
            profileVersion: 1,
            squareUri: "memory://previous-square.jpg",
            originalUri: "memory://previous-original.jpg",
          },
        }),
        readyEntry(1, {
          contentRevision: 2,
          thumbnail: null,
          thumbnailStatus: "unavailable",
        }),
      ],
    };

    const view = await render(<HomeScreen />);

    await waitFor(() => expect(view.getByTestId("draft-item-1")).toBeTruthy());
    expect(view.getByTestId("draft-thumbnail-0").props.source).toEqual({
      uri: "memory://previous-square.jpg",
    });
    expect(view.queryByTestId("draft-thumbnail-1")).toBeNull();
    expect(
      view.getByTestId("draft-thumbnail-placeholder-1", { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(view.queryByText("original")).toBeNull();
  });

  it("[F08-S29] marks corrupt thumbnails and placeholders as warnings that cannot open the Editor", async () => {
    state = {
      status: "ready",
      entries: [
        {
          status: "corrupt",
          draftId: corruptId,
          updatedAt: null,
          photoCount: null,
          reason: "document-corrupt",
          thumbnail: {
            contentRevision: 1,
            profileVersion: 1,
            squareUri: "memory://corrupt-square.jpg",
            originalUri: "memory://corrupt-original.jpg",
          },
        },
        {
          status: "corrupt",
          draftId: draftId("draft:corrupt-without-thumbnail"),
          updatedAt: null,
          photoCount: null,
          reason: "catalog-corrupt",
          thumbnail: null,
        },
      ],
    };

    const view = await render(<HomeScreen />);

    await waitFor(() => expect(view.getByTestId("draft-item-1")).toBeTruthy());
    expect(view.getByTestId("draft-thumbnail-0").props.source).toEqual({
      uri: "memory://corrupt-square.jpg",
    });
    expect(
      view.getByTestId("draft-corrupt-overlay-0", { includeHiddenElements: true }).props,
    ).toEqual(
      expect.objectContaining({
        accessibilityElementsHidden: true,
        importantForAccessibility: "no-hide-descendants",
      }),
    );
    expect(
      view.getByTestId("draft-corrupt-warning-0", { includeHiddenElements: true }),
    ).toHaveTextContent("!");
    expect(
      view.getByTestId("draft-corrupt-placeholder-1", { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(
      view.getByTestId("draft-corrupt-overlay-1", { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(
      view.getByTestId("draft-corrupt-warning-1", { includeHiddenElements: true }),
    ).toHaveTextContent("!");
    expect(view.getByTestId("draft-item-0").props.accessibilityLabel).toContain("damaged");

    await act(async () => fireEvent.press(view.getByTestId("draft-item-0")));

    expect(runtime.openDraft).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalledWith("/editor");
    expect(view.getByTestId("corrupt-delete-confirmation")).toBeTruthy();
  });

  it("[F08-S16] persists one global display mode and switches the whole Grid to contain", async () => {
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

  it("[F08-S21] scrolls to the top only when the opened Draft returns with a new content revision", async () => {
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

  it("[F06-S04][F08-S22][F08-S30] requires the normal-Draft action menu and confirmation, but corrupt tap goes to confirmation", async () => {
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

  it("[F08-S25] replaces an unknown deletion snapshot with a page failure and retries only that decision", async () => {
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

  it("[F08-S31] retries a page-level library read failure without displaying a stale Grid", async () => {
    state = { status: "storage-failed", message: "disk unavailable" };
    const view = await render(<HomeScreen />);
    await waitFor(() => expect(view.getByTestId("home-storage-failed")).toBeTruthy());

    await act(async () => fireEvent.press(view.getByTestId("retry-draft-library")));

    expect(runtime.loadDraftLibrary).toHaveBeenCalledTimes(2);
    await publish({ status: "ready", entries: [] });
    expect(view.queryByTestId("home-storage-failed")).toBeNull();
    expect(view.queryByTestId("draft-item-0")).toBeNull();
  });

  it("[F08-S05] shows a creation error when the Draft publication does not commit", async () => {
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
