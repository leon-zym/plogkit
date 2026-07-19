import { File } from "expo-file-system";

import { createExpoDraftRuntimeStorage } from "@/services/drafts/expoDraftLibrary";
import { createExpoImagePickerSource } from "@/services/image-import/expoImagePickerSource";
import { settingsRuntime } from "@/services/settings/expoSettingsRuntime";

import { EditorRuntime } from "./runtime";

const storage = createExpoDraftRuntimeStorage();
const picker = createExpoImagePickerSource();

export const editorRuntime = new EditorRuntime({
  storage,
  selectCandidates: picker.select,
  loadMetadataPolicy: async () => (await settingsRuntime.load()).defaultMetadataPolicy,
  readMetadataText: async (uri) => {
    const file = new File(uri);
    return file.exists ? file.text() : null;
  },
});
