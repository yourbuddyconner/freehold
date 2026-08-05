import { Link, createRoute } from "@tanstack/react-router";
import { useCodeItem } from "~/lib/hooks";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/code/item",
  component: CodeItemRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    nodeId: typeof search.nodeId === "string" ? search.nodeId : "",
  }),
});

interface CodeItem {
  nodeId: string;
  type: string;
  name: string;
  signature?: string;
  span?: string;
  terms: string[];
  filePath?: string;
}

function ItemRef({ item }: { item: CodeItem }) {
  return (
    <li className="border border-(--border) bg-(--bg-subtle) px-3 py-2 space-y-0.5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm text-(--fg)">{item.name}</span>
        <span className="font-mono text-[10px] uppercase border border-(--border) px-1 py-0.5 text-(--fg-muted)">
          {item.type}
        </span>
      </div>
      {item.signature && (
        <p className="font-mono text-xs text-(--fg-muted) truncate">{item.signature}</p>
      )}
      {item.filePath && (
        <Link
          to="/code/file"
          search={{ path: item.filePath }}
          className="font-mono text-[11px] text-(--fg-muted) hover:text-(--fg) underline"
        >
          {item.filePath}
        </Link>
      )}
    </li>
  );
}

export function CodeItemPage({ nodeId }: { nodeId?: string }) {
  const { data, isLoading, isError } = useCodeItem(nodeId);

  if (!nodeId) {
    return (
      <div className="border border-(--border) bg-(--bg-subtle) p-6 max-w-xl">
        <p className="text-sm text-(--fg-muted)">No item specified.</p>
      </div>
    );
  }

  if (isLoading) return <p className="text-xs text-(--fg-muted)">Loading…</p>;

  if (isError || !data) {
    return (
      <div className="border border-(--border) bg-(--bg-subtle) p-6 max-w-xl">
        <p className="text-sm text-(--fg-muted)">Item not found.</p>
      </div>
    );
  }

  const callersIn: CodeItem[] = (data as { callersIn?: CodeItem[] }).callersIn ?? [];
  const callsOut: CodeItem[] = (data as { callsOut?: CodeItem[] }).callsOut ?? [];
  const item = data as unknown as CodeItem;

  return (
    <article className="max-w-3xl space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-1.5">
          <span
            style={{
              display: "inline-block",
              width: 10,
              height: 3,
              background: "var(--color-accent)",
            }}
            aria-hidden
          />
          <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted)">
            CODE ITEM
          </span>
        </div>
        <h2 className="text-xl font-semibold tracking-tight font-mono">{item.name}</h2>
        <div className="flex flex-wrap gap-1.5">
          <span className="inline-flex items-center border border-(--border) bg-(--bg-subtle) px-1.5 py-0.5 text-[11px] font-mono text-(--fg-muted)">
            {item.type}
          </span>
          {(item.terms ?? []).map((t) => (
            <span
              key={t}
              className="inline-flex items-center border border-(--border) bg-(--bg-subtle) px-1.5 py-0.5 text-[11px] font-mono text-(--fg-muted)"
            >
              {t.split("@")[0]}
            </span>
          ))}
        </div>
        {item.signature && (
          <p className="font-mono text-xs text-(--fg-muted)">{item.signature}</p>
        )}
        {item.filePath && (
          <Link
            to="/code/file"
            search={{ path: item.filePath }}
            className="font-mono text-[11px] text-(--fg-muted) hover:text-(--fg) underline"
          >
            {item.filePath}
          </Link>
        )}
      </header>

      {callersIn.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-(--fg)">Called by</h3>
          <ul className="space-y-1.5">
            {callersIn.map((c) => (
              <ItemRef key={c.nodeId} item={c} />
            ))}
          </ul>
        </section>
      )}

      {callsOut.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-(--fg)">Calls</h3>
          <ul className="space-y-1.5">
            {callsOut.map((c) => (
              <ItemRef key={c.nodeId} item={c} />
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

function CodeItemRoute() {
  const { nodeId } = Route.useSearch();
  return <CodeItemPage nodeId={nodeId} />;
}
