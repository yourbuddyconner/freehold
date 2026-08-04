import { Editor, type EditorOptions } from "@pierre/diffs/edit";
import { EditProvider, File } from "@pierre/diffs/react";
import { useRef, useState } from "react";
import { MarkdownView } from "./MarkdownView";

interface DocEditorProps {
  /** Stored content the edit session starts from */
  initial: string;
  /** Filename drives highlighting (memory.md → markdown) */
  name?: string;
  onSave: (next: string) => void;
  onCancel: () => void;
}

// biome-ignore lint/suspicious/noExplicitAny: EditorOptions' annotation type param is unused here
function createEditor(options: EditorOptions<any>) {
  return new Editor(options);
}

/**
 * Split editing surface: Pierre's editor over the Markdown source on the
 * left, live rendered preview on the right. Save hands the draft to the
 * caller; nothing is written until the commit step.
 */
export function DocEditor({ initial, name = "memory.md", onSave, onCancel }: DocEditorProps) {
  const [draft, setDraft] = useState(initial);
  // The File component needs a stable file object; content changes flow
  // through the editor, not through re-rendering the initial file.
  const fileRef = useRef({ name, contents: initial, cacheKey: `doc-${name}` });

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-4">
        <div className="border border-(--border) min-w-0" data-testid="doc-editor-source">
          <EditProvider createEditor={createEditor}>
            <File
              file={fileRef.current}
              edit
              editorOptions={{
                onChange: (file) => setDraft(file.contents),
              }}
              options={{ disableFileHeader: true, overflow: "wrap" }}
            />
          </EditProvider>
        </div>
        <div
          className="border border-(--border) bg-(--bg-subtle) p-4 min-w-0 overflow-auto"
          data-testid="doc-editor-preview"
        >
          <MarkdownView>{draft}</MarkdownView>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSave(draft)}
          className="border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--color-accent-fg)] hover:opacity-90"
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="border border-(--border) px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted) hover:text-(--fg)"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
