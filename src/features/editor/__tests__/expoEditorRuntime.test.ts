import { editorRuntime } from "../expoEditorRuntime";

jest.mock("@/services/drafts/expoDraftLibrary", () => ({
  createExpoDraftRuntimeStorage: () => ({
    library: {
      create: async (
        _candidates: readonly unknown[],
        options: { readonly metadataPolicy: string },
      ) => {
        expect(options).toEqual({ metadataPolicy: "strip" });
        return {
          status: "created" as const,
          draftId: "draft:settings-fallback",
          errors: [],
        };
      },
    },
  }),
}));

jest.mock("@/services/image-import/expoImagePickerSource", () => ({
  createExpoImagePickerSource: () => ({
    select: async () => [
      {
        uri: "picker://photo.jpg",
        width: 1200,
        height: 900,
        kind: "image" as const,
      },
    ],
  }),
}));

jest.mock("@/services/session/currentEditingSession", () => ({
  createCurrentEditingSession: () => ({
    flush: async () => ({ status: "flushed" as const }),
    open: async () => ({
      status: "opened" as const,
      handle: {},
    }),
  }),
}));

jest.mock("@/services/settings/expoAppSettings", () => ({
  appSettings: {
    initialize: () => new Promise<never>(() => undefined),
    getState: () => ({
      status: "loading" as const,
      settings: {
        defaultMetadataPolicy: "strip" as const,
        draftThumbnailDisplay: "square" as const,
      },
    }),
  },
}));

describe("Expo editor runtime settings integration", () => {
  it("creates a Draft from the safe fallback without waiting for settings initialization", async () => {
    const result = await Promise.race([
      editorRuntime.choosePhotos(),
      new Promise<"settings-blocked">((resolve) => {
        setImmediate(() => resolve("settings-blocked"));
      }),
    ]);

    expect(result).toMatchObject({ status: "created" });
  });
});
