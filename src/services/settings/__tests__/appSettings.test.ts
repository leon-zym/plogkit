import {
  createAppSettings,
  type AppSettingsFileAdapter,
  type AppSettingsModule,
} from "../appSettings";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: Deferred<T>["resolve"] = () => undefined;
  let reject: Deferred<T>["reject"] = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function persisted(
  overrides: Partial<{
    readonly schemaVersion: 1 | 2;
    readonly defaultMetadataPolicy: "strip" | "retain-basic";
    readonly draftThumbnailDisplay: "square" | "original";
  }> = {},
): string {
  return JSON.stringify({
    schemaVersion: 2,
    defaultMetadataPolicy: "strip",
    draftThumbnailDisplay: "square",
    ...overrides,
  });
}

function createMemoryFiles(initial?: string): {
  readonly files: AppSettingsFileAdapter;
  readonly exists: jest.Mock;
  readonly readText: jest.Mock;
  readonly writeText: jest.Mock;
  readonly read: () => string | undefined;
} {
  let content = initial;
  const exists = jest.fn(async () => content !== undefined);
  const readText = jest.fn(async () => {
    if (content === undefined) throw new Error("missing settings");
    return content;
  });
  const writeText = jest.fn(async (_uri: string, next: string) => {
    content = next;
  });
  return {
    files: { exists, readText, writeText },
    exists,
    readText,
    writeText,
    read: () => content,
  };
}

async function readySettings(initial?: string): Promise<{
  readonly settings: AppSettingsModule;
  readonly memory: ReturnType<typeof createMemoryFiles>;
}> {
  const memory = createMemoryFiles(initial);
  const settings = createAppSettings(memory.files, "settings.json");
  await settings.initialize();
  return { settings, memory };
}

describe("App Settings", () => {
  it("[F09-S01] loads privacy-first defaults without writing when no record exists", async () => {
    const memory = createMemoryFiles();
    const settings = createAppSettings(memory.files, "settings.json");

    await expect(settings.initialize()).resolves.toEqual({
      status: "ready",
      settings: {
        defaultMetadataPolicy: "strip",
        draftThumbnailDisplay: "square",
      },
    });
    expect(memory.readText).not.toHaveBeenCalled();
    expect(memory.writeText).not.toHaveBeenCalled();
  });

  it("migrates a version 1 record without exposing its schema", async () => {
    const { settings } = await readySettings(
      JSON.stringify({
        schemaVersion: 1,
        defaultMetadataPolicy: "retain-basic",
      }),
    );

    const state = settings.getState();
    expect(state).toEqual({
      status: "ready",
      settings: {
        defaultMetadataPolicy: "retain-basic",
        draftThumbnailDisplay: "square",
      },
    });
    expect(state.settings).not.toHaveProperty("schemaVersion");
  });

  it.each([
    ["invalid JSON", "{not-json"],
    [
      "invalid known fields",
      JSON.stringify({
        schemaVersion: 2,
        defaultMetadataPolicy: "keep-gps",
        draftThumbnailDisplay: "square",
      }),
    ],
  ])("[F09-S08] uses defaults for %s without rewriting it during load", async (_label, content) => {
    const memory = createMemoryFiles(content);
    const settings = createAppSettings(memory.files, "settings.json");

    await settings.initialize();

    expect(settings.getState()).toEqual({
      status: "ready",
      settings: {
        defaultMetadataPolicy: "strip",
        draftThumbnailDisplay: "square",
      },
    });
    expect(memory.read()).toBe(content);
    expect(memory.writeText).not.toHaveBeenCalled();
  });

  it("shares one physical read across concurrent initialization callers", async () => {
    const memory = createMemoryFiles(persisted());
    const read = deferred<string>();
    memory.readText.mockImplementationOnce(() => read.promise);
    const settings = createAppSettings(memory.files, "settings.json");

    const first = settings.initialize();
    const second = settings.initialize();

    expect(first).toBe(second);
    expect(memory.exists).toHaveBeenCalledTimes(1);
    read.resolve(persisted());
    const results = await Promise.all([first, second]);
    expect(results[0]).toBe(results[1]);
    expect(results[0]).toBe(settings.getState());
    expect(memory.readText).toHaveBeenCalledTimes(1);
  });

  it("[F09-S07] keeps a read failure non-authoritative and retries the original record", async () => {
    const memory = createMemoryFiles(
      persisted({
        defaultMetadataPolicy: "retain-basic",
        draftThumbnailDisplay: "original",
      }),
    );
    memory.exists.mockRejectedValueOnce(new Error("storage unavailable"));
    const settings = createAppSettings(memory.files, "settings.json");

    await expect(settings.initialize()).resolves.toEqual({
      status: "load-failed",
      settings: {
        defaultMetadataPolicy: "strip",
        draftThumbnailDisplay: "square",
      },
    });
    await expect(settings.setDraftThumbnailDisplay("original")).resolves.toMatchObject({
      status: "not-ready",
    });
    expect(memory.writeText).not.toHaveBeenCalled();

    await expect(settings.initialize()).resolves.toEqual({
      status: "ready",
      settings: {
        defaultMetadataPolicy: "retain-basic",
        draftThumbnailDisplay: "original",
      },
    });
    expect(memory.exists).toHaveBeenCalledTimes(2);
  });

  it("[F09-S03] applies interleaved field intents to the latest committed snapshot", async () => {
    const { settings, memory } = await readySettings();
    const firstWrite = deferred<void>();
    memory.writeText
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementation(async (_uri: string, content: string) => {
        expect(JSON.parse(content)).toEqual({
          schemaVersion: 2,
          defaultMetadataPolicy: "retain-basic",
          draftThumbnailDisplay: "original",
        });
      });

    const metadata = settings.setDefaultMetadataPolicy("retain-basic");
    const display = settings.setDraftThumbnailDisplay("original");

    await Promise.resolve();
    expect(memory.writeText).toHaveBeenCalledTimes(1);
    firstWrite.resolve();
    await expect(Promise.all([metadata, display])).resolves.toEqual([
      expect.objectContaining({ status: "saved" }),
      expect.objectContaining({ status: "saved" }),
    ]);
    expect(settings.getState().settings).toEqual({
      defaultMetadataPolicy: "retain-basic",
      draftThumbnailDisplay: "original",
    });
  });

  it("commits same-field intents in their received order", async () => {
    const { settings, memory } = await readySettings();

    await Promise.all([
      settings.setDraftThumbnailDisplay("original"),
      settings.setDraftThumbnailDisplay("square"),
    ]);

    expect(
      memory.writeText.mock.calls.map(([, content]) => JSON.parse(content) as unknown),
    ).toEqual([
      {
        schemaVersion: 2,
        defaultMetadataPolicy: "strip",
        draftThumbnailDisplay: "original",
      },
      {
        schemaVersion: 2,
        defaultMetadataPolicy: "strip",
        draftThumbnailDisplay: "square",
      },
    ]);
    expect(settings.getState().settings.draftThumbnailDisplay).toBe("square");
  });

  it("[F09-S04] does not publish a new snapshot until persistence succeeds", async () => {
    const { settings, memory } = await readySettings();
    const write = deferred<void>();
    memory.writeText.mockImplementationOnce(() => write.promise);
    const listener = jest.fn();
    settings.subscribe(listener);
    const original = settings.getState().settings;

    const update = settings.setDefaultMetadataPolicy("retain-basic");

    expect(settings.getState().settings).toBe(original);
    expect(listener).not.toHaveBeenCalled();
    write.resolve();
    await expect(update).resolves.toMatchObject({ status: "saved" });
    expect(settings.getState().settings.defaultMetadataPolicy).toBe("retain-basic");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("[F09-S05] preserves the old snapshot after a failed write and recovers the queue", async () => {
    const { settings, memory } = await readySettings();
    memory.writeText.mockRejectedValueOnce(new Error("disk full"));
    const listener = jest.fn();
    settings.subscribe(listener);
    const original = settings.getState().settings;

    await expect(settings.setDefaultMetadataPolicy("retain-basic")).resolves.toEqual({
      status: "save-failed",
      settings: original,
    });
    expect(settings.getState().settings).toBe(original);
    expect(listener).not.toHaveBeenCalled();

    await expect(settings.setDraftThumbnailDisplay("original")).resolves.toMatchObject({
      status: "saved",
    });
    expect(settings.getState().settings).toEqual({
      defaultMetadataPolicy: "strip",
      draftThumbnailDisplay: "original",
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("treats the current value as a successful no-op", async () => {
    const { settings, memory } = await readySettings();
    const listener = jest.fn();
    settings.subscribe(listener);
    memory.writeText.mockClear();
    const original = settings.getState().settings;

    await expect(settings.setDefaultMetadataPolicy("strip")).resolves.toEqual({
      status: "saved",
      settings: original,
    });

    expect(memory.writeText).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(settings.getState().settings).toBe(original);
  });

  it("publishes one immutable committed snapshot to every subscriber", async () => {
    const { settings } = await readySettings();
    const observed: object[] = [];
    settings.subscribe(() => observed.push(settings.getState().settings));
    settings.subscribe(() => observed.push(settings.getState().settings));

    const result = await settings.setDraftThumbnailDisplay("original");
    if (result.status !== "saved") throw new Error("expected a saved result");

    expect(observed).toEqual([result.settings, result.settings]);
    expect(settings.getState().settings).toBe(result.settings);
    expect(Object.isFrozen(result.settings)).toBe(true);
  });
});
