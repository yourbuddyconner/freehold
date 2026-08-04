import { Background, Handle, Position, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { createRoute, useNavigate } from "@tanstack/react-router";
import {
  Bot,
  Box,
  CalendarDays,
  FileText,
  Folder,
  SlidersHorizontal,
  StickyNote,
  User,
} from "lucide-react";
import { useMemo, useState } from "react";
import { StatusChip } from "~/components/StatusChip";
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

const GROUP_ICONS: Record<string, typeof StickyNote> = {
  Notes: StickyNote,
  Documents: FileText,
  People: User,
  Preferences: SlidersHorizontal,
  Events: CalendarDays,
  Agents: Bot,
};

interface MemoryNodeData {
  label: string;
  title: string;
  type: string;
  group: string;
  approval: string;
  hub: boolean;
  size: number;
  footprint: number;
  [key: string]: unknown;
}

/** Icon node with its title beneath and a detail card on hover. */
function MemoryNode({ data }: { data: MemoryNodeData }) {
  const [hovered, setHovered] = useState(false);
  const Icon = data.hub ? Folder : (GROUP_ICONS[data.group] ?? Box);
  const pending = data.approval === "pending";

  return (
    <div
      className="flex flex-col items-center"
      style={{ width: data.footprint * 2 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <span
        className="flex items-center justify-center"
        style={{
          width: data.size,
          height: data.size,
          background: data.hub ? "var(--bg-subtle)" : groupColor(data.group),
          border: pending ? "1.5px dashed var(--color-status-pending)" : "1px solid var(--border)",
          opacity: pending ? 0.75 : 1,
          color: data.hub ? "var(--fg-muted)" : "#0e0e0c",
        }}
      >
        <Icon size={Math.max(12, data.size - 12)} strokeWidth={1.75} aria-hidden />
      </span>
      <span
        className="mt-1 text-center leading-tight"
        style={{
          fontSize: 10,
          color: "var(--fg)",
          whiteSpace: "nowrap",
          opacity: pending ? 0.75 : 1,
        }}
      >
        {data.label}
      </span>

      {hovered && (
        <div
          data-testid="graph-hover-card"
          className="border border-(--border) bg-(--bg) p-2.5 space-y-1.5 shadow-md"
          style={{
            position: "absolute",
            bottom: "100%",
            marginBottom: 6,
            minWidth: 200,
            maxWidth: 280,
            zIndex: 1000,
            pointerEvents: "none",
            textAlign: "left",
          }}
        >
          <p className="text-xs text-(--fg) leading-snug">{data.title}</p>
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-(--fg-muted)">
              {data.hub ? "type group" : data.type.split("@")[0]}
            </span>
            {!data.hub && (
              <StatusChip
                status={pending ? "pending" : "approved"}
                label={pending ? "Pending" : "Saved"}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const nodeTypes = { memory: MemoryNode };

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
        type: "memory" as const,
        // Layout positions are centers; React Flow anchors at top-left
        position: { x: n.x - n.footprint, y: n.y - n.size / 2 },
        data: {
          label: n.label,
          title: n.title,
          type: n.type,
          group: n.group,
          approval: n.approval,
          hub: n.hub,
          size: n.size,
          footprint: n.footprint,
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
        style:
          e.type === "containment"
            ? { stroke: "var(--border)", strokeDasharray: "3 3" }
            : { stroke: "var(--fg-muted)", strokeWidth: 1.25 },
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
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1.25 }}
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
