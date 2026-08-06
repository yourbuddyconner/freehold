import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type React from "react";

export interface ChangesetEntry {
  id: string;
  kind: string;
  label: string;
  detail?: string;
  payload: unknown;
  preview?: { name: string; before: string; after: string };
}

interface ChangesetStore {
  graphId: string;
  entries: ChangesetEntry[];
  intent: string;
  stage: (entry: Omit<ChangesetEntry, "id">) => void;
  unstage: (id: string) => void;
  clear: () => void;
  setIntent: (intent: string) => void;
}

const ChangesetContext = createContext<ChangesetStore | null>(null);

function storageKey(graphId: string): string {
  return `freehold:changeset:${graphId}`;
}

function loadFromStorage(graphId: string): ChangesetEntry[] {
  try {
    const raw = localStorage.getItem(storageKey(graphId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ChangesetEntry[];
  } catch {
    return [];
  }
}

const PREVIEW_SIZE_CAP = 100 * 1024; // 100KB

function stripLargePreview(entry: ChangesetEntry): ChangesetEntry {
  if (!entry.preview) return entry;
  const { before, after } = entry.preview;
  if (before.length > PREVIEW_SIZE_CAP || after.length > PREVIEW_SIZE_CAP) {
    const { preview: _preview, ...rest } = entry;
    return rest;
  }
  return entry;
}

function saveToStorage(graphId: string, entries: ChangesetEntry[]): void {
  try {
    if (entries.length === 0) {
      localStorage.removeItem(storageKey(graphId));
    } else {
      localStorage.setItem(storageKey(graphId), JSON.stringify(entries.map(stripLargePreview)));
    }
  } catch {
    // localStorage unavailable — silently skip
  }
}

export function ChangesetProvider({
  graphId,
  children,
}: {
  graphId: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const [entries, setEntries] = useState<ChangesetEntry[]>(() => loadFromStorage(graphId));
  const [intent, setIntentState] = useState<string>("");

  // When graphId changes (graph switcher), reload from storage for new graph.
  useEffect(() => {
    setEntries(loadFromStorage(graphId));
    setIntentState("");
  }, [graphId]);

  const stage = useCallback(
    (entry: Omit<ChangesetEntry, "id">) => {
      const newEntry: ChangesetEntry = { ...entry, id: crypto.randomUUID() };
      setEntries((prev) => {
        const next = [...prev, newEntry];
        saveToStorage(graphId, next);
        return next;
      });
    },
    [graphId]
  );

  const unstage = useCallback(
    (id: string) => {
      setEntries((prev) => {
        const next = prev.filter((e) => e.id !== id);
        saveToStorage(graphId, next);
        return next;
      });
    },
    [graphId]
  );

  const clear = useCallback(() => {
    setEntries([]);
    saveToStorage(graphId, []);
  }, [graphId]);

  const setIntent = useCallback((value: string) => {
    setIntentState(value);
  }, []);

  return (
    <ChangesetContext.Provider
      value={{ graphId, entries, intent, stage, unstage, clear, setIntent }}
    >
      {children}
    </ChangesetContext.Provider>
  );
}

export function useChangeset(): ChangesetStore {
  const ctx = useContext(ChangesetContext);
  if (!ctx) {
    throw new Error("useChangeset must be used within a ChangesetProvider");
  }
  return ctx;
}
