import type { PlogDocument } from "@/core/document";

export interface AutosaveScheduler {
  readonly schedule: (document: PlogDocument) => void;
  readonly flush: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

export interface AutosaveSchedulerOptions {
  readonly delayMs?: number;
}

export function createAutosaveScheduler(
  save: (document: PlogDocument) => Promise<void>,
  { delayMs = 300 }: AutosaveSchedulerOptions = {},
): AutosaveScheduler {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error("autosave delay must be a non-negative finite number");
  }

  let pending: PlogDocument | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let failure: unknown;
  let disposed = false;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const enqueuePending = (): void => {
    clearTimer();
    const document = pending;
    pending = null;
    if (document === null) return;

    chain = chain
      .then(() => save(document))
      .catch((error: unknown) => {
        failure = error;
      });
  };

  const flush = async (): Promise<void> => {
    enqueuePending();
    await chain;
    if (failure !== undefined) {
      const error = failure;
      failure = undefined;
      throw error;
    }
  };

  return {
    schedule: (document) => {
      if (disposed) throw new Error("autosave scheduler is disposed");
      pending = document;
      clearTimer();
      timer = setTimeout(enqueuePending, delayMs);
    },
    flush,
    dispose: async () => {
      disposed = true;
      await flush();
    },
  };
}
