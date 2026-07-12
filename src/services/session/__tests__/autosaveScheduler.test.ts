import { createEmptyDocument } from "@/core/document";
import { setBackgroundColor } from "@/core/operations";

import { createAutosaveScheduler } from "../autosaveScheduler";

describe("autosave scheduler", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("debounces rapid commits and saves only the latest document", async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const scheduler = createAutosaveScheduler(save, { delayMs: 100 });
    const initial = createEmptyDocument();

    scheduler.schedule(setBackgroundColor(initial, "#111111"));
    scheduler.schedule(setBackgroundColor(initial, "#222222"));
    jest.advanceTimersByTime(100);
    await scheduler.flush();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0].canvas.backgroundColor).toBe("#222222");
  });

  it("serializes saves so an older write cannot finish after a newer write", async () => {
    const resolvers: (() => void)[] = [];
    let active = 0;
    let maxActive = 0;
    let callCount = 0;
    let markSecondStarted: (() => void) | undefined;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const save = jest.fn(async () => {
      callCount += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (callCount === 2) markSecondStarted?.();
      await new Promise<void>((resolve) => resolvers.push(resolve));
      active -= 1;
    });
    const scheduler = createAutosaveScheduler(save, { delayMs: 10 });
    const initial = createEmptyDocument();

    scheduler.schedule(setBackgroundColor(initial, "#111111"));
    jest.advanceTimersByTime(10);
    await Promise.resolve();
    scheduler.schedule(setBackgroundColor(initial, "#222222"));
    jest.advanceTimersByTime(10);
    await Promise.resolve();

    expect(save).toHaveBeenCalledTimes(1);
    const flush = scheduler.flush();
    resolvers.shift()?.();
    await secondStarted;
    expect(save).toHaveBeenCalledTimes(2);
    resolvers.shift()?.();
    await flush;
    expect(maxActive).toBe(1);
  });

  it("flushes pending work on dispose and rejects later schedules", async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const scheduler = createAutosaveScheduler(save, { delayMs: 100 });
    const document = createEmptyDocument();

    scheduler.schedule(document);
    await scheduler.dispose();

    expect(save).toHaveBeenCalledWith(document);
    expect(() => scheduler.schedule(document)).toThrow("disposed");
  });

  it("surfaces save failures through flush", async () => {
    const scheduler = createAutosaveScheduler(
      async () => {
        throw new Error("disk full");
      },
      { delayMs: 1 },
    );

    scheduler.schedule(createEmptyDocument());
    await expect(scheduler.flush()).rejects.toThrow("disk full");
  });
});
