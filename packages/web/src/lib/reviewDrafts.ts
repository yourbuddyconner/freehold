export interface CommentDraft {
  path: string;
  span: string; // "L5" | "L5-L9" | "old:L5"
  body: string;
  suggestion?: string;
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

/**
 * Serialize a prose comment + optional suggestion replacement into the
 * GitHub suggestion fence format.
 */
export function serializeSuggestionBody(prose: string, suggestion: string): string {
  const fence = `\`\`\`suggestion\n${suggestion}\n\`\`\``;
  return prose ? `${prose}\n${fence}` : fence;
}

/**
 * Parse a comment body that may contain a suggestion fence block.
 * Returns { prose, suggestion } where suggestion is null if no fence found.
 * Tolerant of surrounding whitespace.
 */
export function parseSuggestionBody(body: string): { prose: string; suggestion: string | null } {
  const fencePattern = /```suggestion\n([\s\S]*?)\n```/;
  const match = body.match(fencePattern);
  if (!match) {
    return { prose: body, suggestion: null };
  }
  const fenceStart = body.indexOf("```suggestion");
  const prose = body.slice(0, fenceStart).trimEnd();
  const suggestion = match[1];
  return { prose, suggestion };
}
