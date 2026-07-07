import { createEmptyDocument } from "../document";
import {
  canRedo,
  canUndo,
  commitHistory,
  createHistory,
  HISTORY_LIMIT,
  redoHistory,
  undoHistory,
} from "../history";
import { setBackgroundColor } from "../operations";

describe("bounded document history", () => {
  it("undoes and redoes committed snapshots", () => {
    const initial = createEmptyDocument();
    const changed = setBackgroundColor(initial, "#000000");
    const committed = commitHistory(createHistory(initial), changed);
    const undone = undoHistory(committed);
    const redone = redoHistory(undone);

    expect(canUndo(committed)).toBe(true);
    expect(committed.current).not.toBe(changed);
    expect(committed.past[0]).not.toBe(initial);
    expect(undone.current).toEqual(initial);
    expect(canRedo(undone)).toBe(true);
    expect(redone.current).toEqual(changed);
  });

  it("keeps at most forty undo snapshots", () => {
    let history = createHistory(createEmptyDocument());

    for (let index = 0; index < HISTORY_LIMIT + 5; index += 1) {
      history = commitHistory(history, setBackgroundColor(history.current, `#${index}`));
    }

    expect(history.past).toHaveLength(HISTORY_LIMIT);
    for (let index = 0; index < HISTORY_LIMIT; index += 1) {
      history = undoHistory(history);
    }
    expect(canUndo(history)).toBe(false);
  });

  it("clears the redo branch after a new commit", () => {
    const initial = createEmptyDocument();
    const first = commitHistory(createHistory(initial), setBackgroundColor(initial, "#111111"));
    const undone = undoHistory(first);
    const branched = commitHistory(undone, setBackgroundColor(undone.current, "#222222"));

    expect(canRedo(undone)).toBe(true);
    expect(canRedo(branched)).toBe(false);
    expect(branched.future).toEqual([]);
  });

  it("returns the same history when undo or redo is unavailable", () => {
    const history = createHistory(createEmptyDocument());

    expect(undoHistory(history)).toBe(history);
    expect(redoHistory(history)).toBe(history);
  });

  it("rejects non-positive history limits", () => {
    expect(() => createHistory(createEmptyDocument(), 0)).toThrow("positive integer");
  });
});
