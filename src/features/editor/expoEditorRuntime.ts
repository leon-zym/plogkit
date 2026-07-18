import { createExpoDraftRuntimeStorage } from "@/services/drafts/expoDraftLibrary";
import { createExpoImagePickerSource } from "@/services/image-import/expoImagePickerSource";
import { createCurrentEditingSession } from "@/services/session/currentEditingSession";
import { settingsRuntime } from "@/services/settings/expoSettingsRuntime";

import { EditorRuntime } from "./runtime";

const storage = createExpoDraftRuntimeStorage();
const picker = createExpoImagePickerSource();
const session = createCurrentEditingSession({ library: storage.library });

export const editorRuntime = new EditorRuntime({
  storage,
  session,
  selectCandidates: picker.select,
  loadMetadataPolicy: async () => (await settingsRuntime.load()).defaultMetadataPolicy,
});
