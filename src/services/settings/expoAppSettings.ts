import { File, Paths } from "expo-file-system";

import {
  commitPreparedFile,
  recoverFile,
  type RecoverableFileAdapter,
  type RecoverableFileState,
} from "@/services/persistence/recoverableFile";

import { createAppSettings, type AppSettingsFileAdapter } from "./appSettings";

const settingsFile = new File(Paths.document, "settings.json");

const expoRecoverableFiles: RecoverableFileAdapter = {
  fileExists: async (uri) => new File(uri).exists,
  moveFile: async (sourceUri, destinationUri) => {
    await new File(sourceUri).move(new File(destinationUri));
  },
  removeFile: async (uri) => {
    new File(uri).delete();
  },
};

async function isCompleteJsonObject(candidateUri: string): Promise<boolean> {
  if (!new File(candidateUri).exists) return false;
  try {
    const parsed: unknown = JSON.parse(await new File(candidateUri).text());
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function settingsFileState(uri: string): RecoverableFileState {
  return {
    currentUri: uri,
    backupUri: `${uri}.backup`,
    temporaryUri: `${uri}.pending`,
    // Recovery detects incomplete file replacement; appSettings owns schema validation.
    isValid: isCompleteJsonObject,
  };
}

export const expoAppSettingsFileAdapter: AppSettingsFileAdapter = {
  exists: async (uri) =>
    new File(uri).exists || recoverFile(expoRecoverableFiles, settingsFileState(uri)),
  readText: async (uri) => {
    if (!new File(uri).exists) {
      await recoverFile(expoRecoverableFiles, settingsFileState(uri));
    }
    return new File(uri).text();
  },
  writeText: async (uri, content) => {
    const state = settingsFileState(uri);
    await recoverFile(expoRecoverableFiles, state);
    const pending = new File(state.temporaryUri);
    try {
      pending.create({ intermediates: true });
      pending.write(content);
    } catch (error: unknown) {
      try {
        if (pending.exists) pending.delete();
      } catch {
        // Recovery removes invalid pending files before a later save.
      }
      throw error;
    }
    await commitPreparedFile(
      expoRecoverableFiles,
      state,
      async (currentUri) => (await new File(currentUri).text()) === content,
    );
  },
};

export const appSettings = createAppSettings(expoAppSettingsFileAdapter, settingsFile.uri);
