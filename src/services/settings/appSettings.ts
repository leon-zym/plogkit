import type { MetadataPolicy } from "@/core/exportPolicy";

const APP_SETTINGS_SCHEMA_VERSION = 2;

export type DraftThumbnailDisplay = "square" | "original";

export interface AppSettings {
  readonly defaultMetadataPolicy: MetadataPolicy;
  readonly draftThumbnailDisplay: DraftThumbnailDisplay;
}

export type AppSettingsState =
  | { readonly status: "uninitialized"; readonly settings: AppSettings }
  | { readonly status: "loading"; readonly settings: AppSettings }
  | { readonly status: "ready"; readonly settings: AppSettings }
  | { readonly status: "load-failed"; readonly settings: AppSettings };

export type AppSettingsUpdateResult =
  | { readonly status: "saved"; readonly settings: AppSettings }
  | { readonly status: "save-failed"; readonly settings: AppSettings }
  | { readonly status: "not-ready"; readonly settings: AppSettings };

export interface AppSettingsModule {
  readonly initialize: () => Promise<AppSettingsState>;
  readonly getState: () => AppSettingsState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly setDefaultMetadataPolicy: (policy: MetadataPolicy) => Promise<AppSettingsUpdateResult>;
  readonly setDraftThumbnailDisplay: (
    display: DraftThumbnailDisplay,
  ) => Promise<AppSettingsUpdateResult>;
}

export interface AppSettingsFileAdapter {
  readonly exists: (uri: string) => Promise<boolean>;
  readonly readText: (uri: string) => Promise<string>;
  readonly writeText: (uri: string, content: string) => Promise<void>;
}

type AppSettingsStatus = AppSettingsState["status"];
type AppSettingsEdit = (current: AppSettings) => AppSettings;

function freezeSettings(settings: AppSettings): AppSettings {
  return Object.freeze({
    defaultMetadataPolicy: settings.defaultMetadataPolicy,
    draftThumbnailDisplay: settings.draftThumbnailDisplay,
  });
}

function defaultAppSettings(): AppSettings {
  return freezeSettings({
    defaultMetadataPolicy: "strip",
    draftThumbnailDisplay: "square",
  });
}

function createState(status: AppSettingsStatus, settings: AppSettings): AppSettingsState {
  return Object.freeze({ status, settings }) as AppSettingsState;
}

function parsePersistedAppSettings(input: unknown): AppSettings {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("settings must be an object");
  }
  const record = input as Record<string, unknown>;
  if (record.schemaVersion !== 1 && record.schemaVersion !== APP_SETTINGS_SCHEMA_VERSION) {
    throw new Error("settings schema is not supported");
  }
  if (record.defaultMetadataPolicy !== "strip" && record.defaultMetadataPolicy !== "retain-basic") {
    throw new Error("default metadata policy is not supported");
  }
  if (record.schemaVersion === 1) {
    return freezeSettings({
      defaultMetadataPolicy: record.defaultMetadataPolicy,
      draftThumbnailDisplay: "square",
    });
  }
  if (record.draftThumbnailDisplay !== "square" && record.draftThumbnailDisplay !== "original") {
    throw new Error("Draft thumbnail display is not supported");
  }
  return freezeSettings({
    defaultMetadataPolicy: record.defaultMetadataPolicy,
    draftThumbnailDisplay: record.draftThumbnailDisplay,
  });
}

function serializeAppSettings(settings: AppSettings): string {
  return JSON.stringify({
    schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
    defaultMetadataPolicy: settings.defaultMetadataPolicy,
    draftThumbnailDisplay: settings.draftThumbnailDisplay,
  });
}

export function createAppSettings(
  files: AppSettingsFileAdapter,
  settingsUri: string,
): AppSettingsModule {
  const fallback = defaultAppSettings();
  const listeners = new Set<() => void>();
  let state = createState("uninitialized", fallback);
  let loadPromise: Promise<AppSettingsState> | null = null;
  let updateQueue: Promise<void> = Promise.resolve();

  const publish = (next: AppSettingsState): AppSettingsState => {
    state = next;
    for (const listener of listeners) listener();
    return next;
  };

  const loadPersisted = async (): Promise<AppSettings> => {
    if (!(await files.exists(settingsUri))) return fallback;
    const content = await files.readText(settingsUri);
    try {
      return parsePersistedAppSettings(JSON.parse(content) as unknown);
    } catch {
      return fallback;
    }
  };

  const initialize = (): Promise<AppSettingsState> => {
    if (state.status === "ready") return Promise.resolve(state);
    if (loadPromise !== null) return loadPromise;

    publish(createState("loading", fallback));
    const attempt = loadPersisted().then(
      (settings) => publish(createState("ready", settings)),
      () => publish(createState("load-failed", fallback)),
    );
    loadPromise = attempt;
    void attempt.then(
      () => {
        if (loadPromise === attempt) loadPromise = null;
      },
      () => {
        if (loadPromise === attempt) loadPromise = null;
      },
    );
    return attempt;
  };

  const update = (edit: AppSettingsEdit): Promise<AppSettingsUpdateResult> => {
    if (state.status !== "ready") {
      return Promise.resolve({ status: "not-ready", settings: state.settings });
    }

    const operation = updateQueue.then(async (): Promise<AppSettingsUpdateResult> => {
      if (state.status !== "ready") {
        return { status: "not-ready", settings: state.settings };
      }
      const current = state.settings;
      const next = freezeSettings(edit(current));
      if (
        next.defaultMetadataPolicy === current.defaultMetadataPolicy &&
        next.draftThumbnailDisplay === current.draftThumbnailDisplay
      ) {
        return { status: "saved", settings: current };
      }
      try {
        await files.writeText(settingsUri, serializeAppSettings(next));
      } catch {
        return { status: "save-failed", settings: current };
      }
      publish(createState("ready", next));
      return { status: "saved", settings: next };
    });
    updateQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  return {
    initialize,
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDefaultMetadataPolicy: (policy) =>
      update((current) => ({
        ...current,
        defaultMetadataPolicy: policy,
      })),
    setDraftThumbnailDisplay: (display) =>
      update((current) => ({
        ...current,
        draftThumbnailDisplay: display,
      })),
  };
}
