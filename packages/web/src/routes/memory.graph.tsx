import { Background, Handle, Position, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { createRoute, useNavigate } from "@tanstack/react-router";
import {
  Bot,
  Box,
  CalendarDays,
  FileText,
  Folder,
  FolderOpen,
  SlidersHorizontal,
  StickyNote,
  User,
} from "lucide-react";
import { type CSSProperties, useMemo, useState } from "react";
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
  kind: "group" | "member";
  expanded: boolean;
  count?: number;
  size: number;
  footprint: number;
  [key: string]: unknown;
}

/** Invisible 1px handle centered on the icon, not the node box. */
function handleStyle(iconSize: number): CSSProperties {
  return {
    opacity: 0,
    left: "50%",
    top: iconSize / 2,
    transform: "translate(-50%, -50%)",
    width: 1,
    height: 1,
    minWidth: 0,
    minHeight: 0,
    border: 0,
    pointerEvents: "none",
  };
}

/** Icon node with its title beneath and a detail card on hover. */
function MemoryNode({ data }: { data: MemoryNodeData }) {
  const [hovered, setHovered] = useState(false);
  const isGroup = data.kind === "group";
  const Icon = isGroup ? (data.expanded ? FolderOpen : Folder) : (GROUP_ICONS[data.group] ?? Box);
  const pending = data.approval === "pending";

  return (
    <div
      className="graph-node-pop flex flex-col items-center"
      style={{ width: data.footprint * 2 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Both handles sit at the icon's center so straight edges radiate
          from the vertex; the opaque icon hides the line endpoints. */}
      <Handle type="target" position={Position.Top} style={handleStyle(data.size)} />
      <Handle type="source" position={Position.Bottom} style={handleStyle(data.size)} />
      <span
        className="relative flex items-center justify-center"
        style={{
          width: data.size,
          height: data.size,
          background: isGroup && data.expanded ? "var(--bg-subtle)" : groupColor(data.group),
          border: pending ? "1.5px dashed var(--color-status-pending)" : "1px solid var(--border)",
          opacity: pending ? 0.75 : 1,
          color: isGroup && data.expanded ? "var(--fg-muted)" : "#0e0e0c",
          cursor: "pointer",
        }}
      >
        <Icon size={Math.max(12, data.size - 14)} strokeWidth={1.75} aria-hidden />
        {isGroup && !data.expanded && data.count !== undefined && (
          <span
            className="absolute -top-1.5 -right-1.5 flex items-center justify-center border border-(--border) bg-(--bg) font-mono"
            style={{ minWidth: 15, height: 15, fontSize: 9, padding: "0 3px" }}
          >
            {data.count}
          </span>
        )}
      </span>
      <span
        className="mt-1 text-center leading-tight"
        style={{
          fontSize: 10,
          color: "var(--fg)",
          whiteSpace: "nowrap",
          opacity: pending ? 0.75 : 1,
          fontFamily: isGroup ? "'IBM Plex Mono', monospace" : undefined,
          textTransform: isGroup ? ("uppercase" as const) : undefined,
          letterSpacing: isGroup ? "0.06em" : undefined,
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
              {isGroup
                ? data.expanded
                  ? "click to collapse"
                  : "click to expand"
                : data.type.split("@")[0]}
            </span>
            {!isGroup && (
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const navigate = useNavigate();

  const layout = useMemo(() => {
    if (!data) return { nodes: [], edges: [] };
    return layoutGraph(data.nodes, data.edges, { expanded });
  }, [data, expanded]);

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
          kind: n.kind,
          expanded: expanded.has(n.group),
          count: n.count,
          size: n.size,
          footprint: n.footprint,
        },
      })),
    [layout, expanded]
  );

  const flowEdges = useMemo(
    () =>
      layout.edges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        type: "straight" as const,
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
      <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted)">
        Click a folder to expand its group; click an item to open it.
        {data.truncated && (
          <span data-testid="truncation-notice">
            {" "}
            Showing the {data.nodes.length} most recent nodes — the rest are omitted.
          </span>
        )}
      </p>
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
            if (node.id.startsWith("group:")) {
              const group = node.id.slice("group:".length);
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(group)) {
                  next.delete(group);
                } else {
                  next.add(group);
                }
                return next;
              });
            } else {
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
