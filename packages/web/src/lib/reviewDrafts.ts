export interface CommentDraft {
  path: string;
  span: string; // "L5" | "L5-L9" | "old:L5"
  body: string;
}

const KEY = (sha: string) => `freehold:review-drafts:${sha}`;

export function loadDrafts(sha: string): CommentDraft[] {
  try {
    return JSON.parse(localStorage.getItem(KEY(sha)) ?? "[]") as CommentDraft[];
  } catch {
    return [];
  }
}

export function saveDrafts(sha: string, drafts: CommentDraft[]): void {
  try {
    localStorage.setItem(KEY(sha), JSON.stringify(drafts));
  } catch {}
}

export function clearDrafts(sha: string): void {
  try {
    localStorage.removeItem(KEY(sha));
  } catch {}
}
