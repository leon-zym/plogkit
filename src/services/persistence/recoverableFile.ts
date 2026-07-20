export interface RecoverableFileAdapter {
  readonly fileExists: (uri: string) => Promise<boolean>;
  readonly moveFile: (sourceUri: string, destinationUri: string) => Promise<void>;
  readonly removeFile: (uri: string) => Promise<void>;
}

export interface RecoverableFileState {
  readonly currentUri: string;
  readonly backupUri: string;
  readonly temporaryUri: string;
  readonly isValid: (uri: string) => Promise<boolean>;
}

async function exists(files: RecoverableFileAdapter, uri: string): Promise<boolean> {
  return files.fileExists(uri);
}

async function isValid(state: RecoverableFileState, uri: string): Promise<boolean> {
  return state.isValid(uri);
}

async function removeIfPresent(files: RecoverableFileAdapter, uri: string): Promise<void> {
  if (await exists(files, uri)) await files.removeFile(uri);
}

async function bestEffortRemove(files: RecoverableFileAdapter, uri: string): Promise<void> {
  try {
    await removeIfPresent(files, uri);
  } catch {
    // A valid current file is already committed; later recovery retries sidecar cleanup.
  }
}

async function promote(
  files: RecoverableFileAdapter,
  sourceUri: string,
  state: RecoverableFileState,
): Promise<boolean> {
  await removeIfPresent(files, state.currentUri);
  await files.moveFile(sourceUri, state.currentUri);
  return isValid(state, state.currentUri);
}

export async function recoverFile(
  files: RecoverableFileAdapter,
  state: RecoverableFileState,
): Promise<boolean> {
  if (await isValid(state, state.currentUri)) {
    await bestEffortRemove(files, state.backupUri);
    await bestEffortRemove(files, state.temporaryUri);
    return true;
  }

  if (await isValid(state, state.backupUri)) {
    if (!(await promote(files, state.backupUri, state))) return false;
    await bestEffortRemove(files, state.temporaryUri);
    return true;
  }

  if (await isValid(state, state.temporaryUri)) {
    if (!(await promote(files, state.temporaryUri, state))) return false;
    await bestEffortRemove(files, state.backupUri);
    return true;
  }

  await bestEffortRemove(files, state.backupUri);
  await bestEffortRemove(files, state.temporaryUri);
  return false;
}

export async function commitPreparedFile(
  files: RecoverableFileAdapter,
  state: RecoverableFileState,
  isPreparedCurrent: (uri: string) => Promise<boolean>,
): Promise<void> {
  try {
    if (await exists(files, state.currentUri)) {
      await files.moveFile(state.currentUri, state.backupUri);
    }
    await files.moveFile(state.temporaryUri, state.currentUri);
    if (!(await isValid(state, state.currentUri))) {
      throw new Error("replacement did not produce a valid current file");
    }
    await bestEffortRemove(files, state.backupUri);
  } catch (error: unknown) {
    let recovered = false;
    try {
      recovered = await recoverFile(files, state);
    } catch {
      // Preserve every remaining candidate for restart recovery.
    }
    if (recovered) {
      try {
        if (await isPreparedCurrent(state.currentUri)) return;
      } catch {
        // The original move failure remains the observable transaction result.
      }
    }
    throw error;
  }
}
