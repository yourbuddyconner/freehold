import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";

interface PierreDiffProps {
  oldText: string;
  newText: string;
  /** Filename drives syntax highlighting; default renders as Markdown. */
  name?: string;
  split?: boolean;
}

function activeTheme(): "dark" | "light" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/**
 * The console's one diff surface: renders old vs new text with @pierre/diffs.
 * Unified by default; split where the caller has the width.
 */
export function PierreDiff({
  oldText,
  newText,
  name = "memory.md",
  split = false,
}: PierreDiffProps) {
  const fileDiff = useMemo(
    () => parseDiffFromFile({ name, contents: oldText }, { name, contents: newText }),
    [oldText, newText, name]
  );

  return (
    <div data-testid="pierre-diff" className="border border-(--border) text-sm">
      <FileDiff
        fileDiff={fileDiff}
        options={{
          diffStyle: split ? "split" : "unified",
          lineDiffType: "word-alt",
          disableFileHeader: true,
          overflow: "wrap",
          themeType: activeTheme(),
        }}
      />
    </div>
  );
}
