import { Background, Handle, Position, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { createRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useCodeNeighborhood } from "~/lib/hooks";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/code/graph",
  component: CodeGraphRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    path: typeof search.path === "string" ? search.path : "",
  }),
});

interface CodeNodeData {
  label: string;
  type: string;
  terms: string[];
  [key: string]: unknown;
}

function CodeNode({ data }: { data: CodeNodeData }) {
  return (
    <div
      className="border border-(--border) bg-(--bg-subtle) px-3 py-2 min-w-[120px]"
      data-testid="code-graph-node"
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0 }}
      />
      <p className="font-mono text-xs font-semibold text-(--fg) truncate">{data.label}</p>
      <div className="flex flex-wrap gap-1 mt-1">
        <span className="font-mono text-[9px] uppercase border border-(--border) px-1 text-(--fg-muted)">
          {data.type.split("/").pop()?.split("@")[0] ?? data.type}
        </span>
        {data.terms.map((t) => (
          <span
            key={t}
            className="font-mono text-[9px] border border-(--border) px-1 text-(--fg-muted)"
          >
            {t.split("@")[0]}
          </span>
        ))}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0 }}
      />
    </div>
  );
}

const nodeTypes = { code: CodeNode };

/** Lay nodes out in a simple horizontal grid — no library needed for small neighborhoods. */
function layoutNodes(
  nodes: Array<{ id: string; label: string; type: string; terms: string[] }>
): Array<{ id: string; position: { x: number; y: number }; data: CodeNodeData; type: "code" }> {
  const COLS = 4;
  const COL_W = 200;
  const ROW_H = 120;
  return nodes.map((n, i) => ({
    id: n.id,
    type: "code" as const,
    position: { x: (i % COLS) * COL_W, y: Math.floor(i / COLS) * ROW_H },
    data: { label: n.label, type: n.type, terms: n.terms },
  }));
}

export function CodeGraphPage({ filePath }: { filePath?: string }) {
  const { data, isLoading } = useCodeNeighborhood(filePath);

  const flowNodes = useMemo(() => {
    if (!data) return [];
    return layoutNodes(data.nodes);
  }, [data]);

  const flowEdges = useMemo(() => {
    if (!data) return [];
    return data.edges.map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      type: "straight" as const,
      style: { stroke: "var(--fg-muted)", strokeWidth: 1.25 },
      animated: false,
    }));
  }, [data]);

  if (!filePath) {
    return (
      <div className="border border-(--border) bg-(--bg-subtle) p-6 max-w-xl">
        <p className="text-sm text-(--fg-muted)">No file path specified.</p>
      </div>
    );
  }

  if (isLoading) {
    return <p className="text-xs text-(--fg-muted)">Loading…</p>;
  }

  if (!data || data.nodes.length === 0) {
    return (
      <div className="border border-(--border) bg-(--bg-subtle) p-6 max-w-xl">
        <p className="text-sm text-(--fg-muted)">
          No neighborhood data. The file may not be indexed yet.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted)">
        {filePath} — {data.nodes.length} node{data.nodes.length !== 1 ? "s" : ""}
      </p>
      <div
        className="border border-(--border) bg-(--bg)"
        style={{ height: "calc(100vh - 260px)", minHeight: 420 }}
        data-testid="code-graph-canvas"
      >
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1.5 }}
          nodesDraggable={false}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} size={1} />
        </ReactFlow>
      </div>
    </div>
  );
}

function CodeGraphRoute() {
  const { path } = Route.useSearch();
  return <CodeGraphPage filePath={path} />;
}
