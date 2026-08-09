import "@/i18n";

import { act, fireEvent, render } from "@testing-library/react-native";

import { editorRuntime } from "@/features/editor/expoEditorRuntime";
import { appSettings } from "@/services/settings/expoAppSettings";

import HomeScreen from "../index";

const mockPush = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));

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
    setDraftThumbnailDisplay: jest.fn(),
  },
}));

const runtime = editorRuntime as unknown as {
  loadDraftLibrary: jest.Mock;
  getDraftLibraryState: jest.Mock;
  subscribeDraftLibrary: jest.Mock;
  choosePhotos: jest.Mock;
};

const settings = appSettings as unknown as {
  initialize: jest.Mock;
  getState: jest.Mock;
  subscribe: jest.Mock;
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("Home image import flow", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    runtime.getDraftLibraryState.mockReturnValue({ status: "ready", entries: [] });
    runtime.loadDraftLibrary.mockResolvedValue({ status: "ready", entries: [] });
    runtime.subscribeDraftLibrary.mockReturnValue(() => undefined);
    settings.getState.mockReturnValue({
      status: "ready",
      settings: {
        defaultMetadataPolicy: "strip",
        draftThumbnailDisplay: "square",
      },
    });
    settings.subscribe.mockReturnValue(() => undefined);
    settings.initialize.mockResolvedValue({
      status: "ready",
      settings: {
        defaultMetadataPolicy: "strip",
        draftThumbnailDisplay: "square",
      },
    });
  });

  it("shows a live waiting state until an iCloud-backed selection succeeds", async () => {
    const importResult = deferred<{
      readonly status: "created";
      readonly draftId: string;
      readonly contentRevision: number;
      readonly errors: readonly [];
    }>();
    runtime.choosePhotos.mockReturnValue(importResult.promise);
    const view = await render(<HomeScreen />);

    await act(async () => fireEvent.press(view.getByTestId("choose-photos")));

    expect(view.getByTestId("home-importing")).toHaveTextContent("Preparing photos…");
    expect(view.queryByTestId("choose-photos")).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();

    await act(async () => {
      importResult.resolve({
        status: "created",
        draftId: "draft:icloud-success",
        contentRevision: 1,
        errors: [],
      });
      await importResult.promise;
    });

    expect(mockPush).toHaveBeenCalledWith("/editor");
    expect(view.queryByTestId("home-importing")).toBeNull();
  });

  it.each(["iCloud download timed out", "iCloud download failed"])(
    "shows explicit feedback and does not enter Editor when import rejects: %s",
    async (message) => {
      const importResult = deferred<never>();
      runtime.choosePhotos.mockReturnValue(importResult.promise);
      const view = await render(<HomeScreen />);

      await act(async () => fireEvent.press(view.getByTestId("choose-photos")));
      await act(async () => {
        importResult.reject(new Error(message));
        await expect(importResult.promise).rejects.toThrow(message);
      });

      expect(view.getByTestId("home-error")).toHaveTextContent(
        "We couldn't prepare those photos. Try choosing them again.",
      );
      expect(mockPush).not.toHaveBeenCalled();
      expect(view.getByTestId("choose-photos")).toBeTruthy();
    },
  );

  it("enters Editor when the created Draft contains successful items and import errors", async () => {
    runtime.choosePhotos.mockResolvedValue({
      status: "created",
      draftId: "draft:partial-success",
      contentRevision: 1,
      errors: [
        {
          index: 1,
          sourceUri: "file:///picker/icloud-failed.heic",
          message: "iCloud download failed",
        },
      ],
    });
    const view = await render(<HomeScreen />);

    await act(async () => fireEvent.press(view.getByTestId("choose-photos")));

    expect(mockPush).toHaveBeenCalledWith("/editor");
    expect(view.queryByTestId("home-error")).toBeNull();
  });
});
