import { useSyncExternalStore } from "react";

import type { EditCommitModule, EditCommitSnapshot } from "@/core/editing";

export function useEditCommit(module: EditCommitModule): EditCommitSnapshot {
  return useSyncExternalStore(module.subscribe, module.read, module.read);
}
