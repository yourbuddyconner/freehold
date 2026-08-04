import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Rendered Markdown with the console's prose styles. */
export function MarkdownView({ children }: { children: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
