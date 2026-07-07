import { cloneDocument, type PlogDocument } from "./document";

export const HISTORY_LIMIT = 40;

export interface DocumentHistory {
  readonly past: readonly PlogDocument[];
  readonly current: PlogDocument;
  readonly future: readonly PlogDocument[];
  readonly limit: number;
}

function requireLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("history limit must be a positive integer");
  }
}

export function createHistory(initial: PlogDocument, limit = HISTORY_LIMIT): DocumentHistory {
  requireLimit(limit);
  return {
    past: [],
    current: cloneDocument(initial),
    future: [],
    limit,
  };
}

export function canUndo(history: DocumentHistory): boolean {
  return history.past.length > 0;
}

export function canRedo(history: DocumentHistory): boolean {
  return history.future.length > 0;
}

export function commitHistory(history: DocumentHistory, next: PlogDocument): DocumentHistory {
  requireLimit(history.limit);
  return {
    past: [...history.past, cloneDocument(history.current)].slice(-history.limit),
    current: cloneDocument(next),
    future: [],
    limit: history.limit,
  };
}

export function undoHistory(history: DocumentHistory): DocumentHistory {
  if (!canUndo(history)) {
    return history;
  }
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) {
    return history;
  }
  return {
    past: history.past.slice(0, -1),
    current: cloneDocument(previous),
    future: [cloneDocument(history.current), ...history.future],
    limit: history.limit,
  };
}

export function redoHistory(history: DocumentHistory): DocumentHistory {
  const next = history.future[0];
  if (next === undefined) {
    return history;
  }
  return {
    past: [...history.past, cloneDocument(history.current)].slice(-history.limit),
    current: cloneDocument(next),
    future: history.future.slice(1),
    limit: history.limit,
  };
}
