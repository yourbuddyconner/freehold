/**
 * Appearance theme. Three choices: `system`, `light`, `dark`.
 * Persisted to `localStorage["freehold-theme"]` and applied by setting/removing
 * `data-theme` on `<html>`.
 *
 * Functions take injectable `storage`/`root` so the logic is unit-testable
 * without a real DOM/localStorage.
 *
 * `applyStoredTheme()` is called once at app boot, before first paint (see `main.tsx`),
 * so a returning user with `dark` stored doesn't flash light before React mounts.
 */

export type ThemeChoice = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "freehold-theme";

interface StorageReader {
  getItem(key: string): string | null;
}

interface StorageWriter {
  setItem(key: string, value: string): void;
}

interface ThemeRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export function readStoredTheme(storage: StorageReader = safeLocalStorage()): ThemeChoice {
  const raw = storage.getItem(THEME_STORAGE_KEY);
  return raw === "light" || raw === "dark" ? raw : "system";
}

export function themeAttributeValue(choice: ThemeChoice): "light" | "dark" | null {
  return choice === "system" ? null : choice;
}

function applyAttribute(root: ThemeRoot, choice: ThemeChoice): void {
  const attr = themeAttributeValue(choice);
  if (attr) root.setAttribute("data-theme", attr);
  else root.removeAttribute("data-theme");
}

export function setTheme(
  choice: ThemeChoice,
  opts: { root?: ThemeRoot; storage?: StorageWriter } = {}
): void {
  const root = opts.root ?? documentRoot();
  const storage = opts.storage ?? safeLocalStorage();
  storage.setItem(THEME_STORAGE_KEY, choice);
  applyAttribute(root, choice);
}

export function applyStoredTheme(opts: { root?: ThemeRoot; storage?: StorageReader } = {}): void {
  const root = opts.root ?? documentRoot();
  const storage = opts.storage ?? safeLocalStorage();
  applyAttribute(root, readStoredTheme(storage));
}

function documentRoot(): ThemeRoot {
  return document.documentElement;
}

const memoryStorage = new Map<string, string>();

function safeLocalStorage(): StorageReader & StorageWriter {
  const candidate: unknown = typeof window !== "undefined" ? window.localStorage : undefined;
  if (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof (candidate as Partial<Storage>).getItem === "function" &&
    typeof (candidate as Partial<Storage>).setItem === "function"
  ) {
    return candidate as StorageReader & StorageWriter;
  }
  return {
    getItem: (key) => memoryStorage.get(key) ?? null,
    setItem: (key, value) => {
      memoryStorage.set(key, value);
    },
  };
}
