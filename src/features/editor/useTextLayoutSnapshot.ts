import { useEffect, useRef, useState } from "react";

import type { SceneText } from "@/render/scene";
import {
  createTextLayoutSnapshot,
  type AnyTextLayoutEnvironment,
  type TextLayoutFailure,
  type TextLayoutSnapshot,
} from "@/render/textLayout";

export interface TextLayoutSnapshotState {
  readonly snapshot: TextLayoutSnapshot | null;
  readonly failure: TextLayoutFailure | null;
}

const INITIAL_STATE: TextLayoutSnapshotState = Object.freeze({ snapshot: null, failure: null });

/** Commits a complete replacement before releasing the previously rendered snapshot. */
export function useTextLayoutSnapshot(
  environment: AnyTextLayoutEnvironment,
  texts: readonly SceneText[],
): TextLayoutSnapshotState {
  const [state, setState] = useState<TextLayoutSnapshotState>(INITIAL_STATE);
  const committedSnapshot = useRef<TextLayoutSnapshot | null>(null);
  const latestCreatedSnapshot = useRef<TextLayoutSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    const result = createTextLayoutSnapshot(environment, texts);
    if (result.status === "ready") {
      const superseded = latestCreatedSnapshot.current;
      if (superseded !== null && superseded !== committedSnapshot.current) superseded.dispose();
      latestCreatedSnapshot.current = result.snapshot;
    }

    void Promise.resolve().then(() => {
      if (cancelled) {
        if (
          result.status === "ready" &&
          result.snapshot !== committedSnapshot.current &&
          result.snapshot === latestCreatedSnapshot.current
        ) {
          result.snapshot.dispose();
          latestCreatedSnapshot.current = null;
        }
        return;
      }
      if (result.status === "failure") {
        // Retain the last complete snapshot; never substitute guessed geometry or a fallback font.
        setState((current) => ({ snapshot: current.snapshot, failure: result }));
      } else {
        setState({ snapshot: result.snapshot, failure: null });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [environment, texts]);

  useEffect(() => {
    const previous = committedSnapshot.current;
    committedSnapshot.current = state.snapshot;
    if (previous !== null && previous !== state.snapshot) previous.dispose();
  }, [state.snapshot]);

  useEffect(
    () => () => {
      const committed = committedSnapshot.current;
      const latest = latestCreatedSnapshot.current;
      committed?.dispose();
      if (latest !== null && latest !== committed) latest.dispose();
      committedSnapshot.current = null;
      latestCreatedSnapshot.current = null;
    },
    [],
  );

  return state;
}
