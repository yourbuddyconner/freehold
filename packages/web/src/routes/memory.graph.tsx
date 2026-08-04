import { Background, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { layoutGraph } from "~/lib/graphLayout";
import { useMemoryGraph } from "~/lib/hooks";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/memory/graph",
  component: MemoryGraphRoute,
});

/** Group color palette — matches the console's flat, saturated-accent register. */
const PALETTE = ["#d9f103", "#7dd3fc", "#f9a8d4", "#a7f3d0", "#fcd34d", "#c4b5fd"];

function groupColor(group: string): string {
  let h = 5381;
  for (let i = 0; i < group.length; i++) {
    h = (h * 33) ^ group.charCodeAt(i);
  }
  return PALETTE[(h >>> 0) % PALETTE.length];
}

export function MemoryGraphPage() {
  const { data, isLoading } = useMemoryGraph();
  const [hubs, setHubs] = useState(true);
  const navigate = useNavigate();

  const layout = useMemo(() => {
    if (!data) return { nodes: [], edges: [] };
    return layoutGraph(data.nodes, data.edges, { hubs });
  }, [data, hubs]);

  const flowNodes = useMemo(
    () =>
      layout.nodes.map((n) => ({
        id: n.id,
        position: { x: n.x, y: n.y },
        data: { label: n.title },
        style: {
          width: "auto",
          minWidth: n.size + 24,
          padding: "3px 8px",
          fontSize: n.hub ? 10 : 11,
          fontFamily: n.hub ? "'IBM Plex Mono', monospace" : undefined,
          textTransform: n.hub ? ("uppercase" as const) : undefined,
          letterSpacing: n.hub ? "0.08em" : undefined,
          borderRadius: 0,
          border:
            n.approval === "pending"
              ? "1px dashed var(--color-status-pending)"
              : "1px solid var(--border)",
          background: n.hub ? "var(--bg-subtle)" : groupColor(n.group),
          color: n.hub ? "var(--fg-muted)" : "#0e0e0c",
          opacity: n.approval === "pending" ? 0.6 : 1,
        },
      })),
    [layout]
  );

  const flowEdges = useMemo(
    () =>
      layout.edges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        label: e.type === "containment" ? undefined : e.type.split("@")[0].split("/").pop(),
        labelStyle: { fontSize: 9, fill: "var(--fg-muted)" },
        labelBgStyle: { fill: "transparent" },
        style:
          e.type === "containment"
            ? { stroke: "var(--border)", strokeDasharray: "3 3" }
            : { stroke: "var(--fg-muted)" },
        animated: false,
      })),
    [layout]
  );

  if (isLoading) {
    return <p className="text-sm text-(--fg-muted)">Loading graph…</p>;
  }

  if (!data || data.nodes.length === 0) {
    return (
      <div className="border border-(--border) bg-(--bg-subtle) p-6 max-w-xl">
        <p className="text-sm text-(--fg-muted)">
          Nothing to draw yet. The graph fills in as agents relate memories to each other.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted)">
          <input
            type="checkbox"
            checked={hubs}
            onChange={(e) => setHubs(e.target.checked)}
            data-testid="hub-toggle"
          />
          Type hubs
        </label>
        {data.truncated && (
          <span className="font-mono text-[11px] text-(--fg-muted)" data-testid="truncation-notice">
            Showing the {data.nodes.length} most recent nodes — the rest are omitted.
          </span>
        )}
      </div>
      <div
        className="border border-(--border) bg-(--bg)"
        style={{ height: "calc(100vh - 260px)", minHeight: 420 }}
        data-testid="graph-canvas"
      >
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_e, node) => {
            if (!node.id.startsWith("hub:")) {
              navigate({ to: "/memory/$id", params: { id: node.id } });
            }
          }}
        >
          <Background gap={24} size={1} />
        </ReactFlow>
      </div>
    </div>
  );
}

function MemoryGraphRoute() {
  return <MemoryGraphPage />;
}
