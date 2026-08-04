import { Background, Handle, Position, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { createRoute } from "@tanstack/react-router";
import { type CSSProperties, useMemo, useState } from "react";
import { TermOutline } from "~/components/TermOutline";
import { TypeCard } from "~/components/TypeCard";
import { usePending, useSchema } from "~/lib/hooks";
import { SCHEMA_NODE_H, layoutSchema } from "~/lib/schemaLayout";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/schema",
  component: SchemaPage,
});

/** Package tint palette — same register as the memory graph. */
const PALETTE = ["#d9f103", "#7dd3fc", "#f9a8d4", "#a7f3d0", "#fcd34d", "#c4b5fd"];

function packageColor(pkg: string): string {
  let h = 5381;
  for (let i = 0; i < pkg.length; i++) {
    h = (h * 33) ^ pkg.charCodeAt(i);
  }
  return PALETTE[(h >>> 0) % PALETTE.length];
}

function centerHandle(): CSSProperties {
  return {
    opacity: 0,
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%)",
    width: 1,
    height: 1,
    minWidth: 0,
    minHeight: 0,
    border: 0,
    pointerEvents: "none",
  };
}

interface TypeNodeData {
  shortName: string;
  package: string;
  attrCount: number;
  pending: boolean;
  width: number;
  selected: boolean;
  [key: string]: unknown;
}

function TypeNode({ data }: { data: TypeNodeData }) {
  return (
    <div
      className="flex flex-col items-center justify-center"
      style={{
        width: data.width,
        height: SCHEMA_NODE_H,
        background: packageColor(data.package),
        border: data.pending
          ? "1.5px dashed var(--color-status-pending)"
          : data.selected
            ? "2px solid var(--fg)"
            : "1px solid var(--border)",
        color: "#0e0e0c",
        cursor: "pointer",
        opacity: data.pending ? 0.8 : 1,
      }}
    >
      <Handle type="target" position={Position.Top} style={centerHandle()} />
      <Handle type="source" position={Position.Bottom} style={centerHandle()} />
      <span className="text-[13px] font-semibold leading-none">{data.shortName}</span>
      <span className="mt-1 font-mono text-[9px] uppercase tracking-[0.06em] opacity-70">
        {data.package} · {data.attrCount} attr{data.attrCount === 1 ? "" : "s"}
      </span>
    </div>
  );
}

const nodeTypes = { schemaType: TypeNode };

interface EntityTypeRaw {
  name: string;
  package?: string;
  attributes?: Record<string, unknown>;
  extends?: string;
}

function normalizeAttributes(raw: Record<string, unknown> | undefined) {
  if (!raw) return [];
  return Object.entries(raw).map(([name, val]) => {
    if (typeof val === "object" && val !== null) {
      const obj = val as Record<string, unknown>;
      return {
        name,
        type: typeof obj.type === "string" ? obj.type : JSON.stringify(val),
        required: obj.required === true,
      };
    }
    return { name, type: typeof val === "string" ? val : JSON.stringify(val), required: false };
  });
}

function SchemaPage() {
  const { data: schema, isLoading } = useSchema();
  const { data: pendingData } = usePending();
  const [selected, setSelected] = useState<string | undefined>();

  const entityTypes: EntityTypeRaw[] = schema?.entityTypes ?? [];
  const edgeTypes = schema?.edgeTypes ?? [];
  const terms = schema?.terms ?? [];

  const pendingProposals = (pendingData?.proposals ?? []).filter((p) => p.isSchemaProposal);
  const pendingTypeNames = new Set(pendingProposals.flatMap((p) => p.diff.map((d) => d.key)));

  const layout = useMemo(
    () => layoutSchema(entityTypes, edgeTypes, pendingTypeNames),
    [entityTypes, edgeTypes, pendingTypeNames]
  );

  const flowNodes = useMemo(
    () =>
      layout.nodes.map((n) => ({
        id: n.id,
        type: "schemaType" as const,
        position: { x: n.x, y: n.y },
        data: {
          shortName: n.shortName,
          package: n.package,
          attrCount: n.attrCount,
          pending: n.pending,
          width: n.width,
          selected: selected === n.id,
        },
      })),
    [layout, selected]
  );

  const flowEdges = useMemo(
    () =>
      layout.edges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        type: "straight" as const,
        label: e.label,
        labelStyle: {
          fontSize: 9,
          fill: "var(--fg-muted)",
          fontFamily: "'IBM Plex Mono', monospace",
        },
        labelBgStyle: { fill: "var(--bg)", fillOpacity: 0.85 },
        style:
          e.kind === "extends"
            ? { stroke: "var(--fg-muted)", strokeWidth: 1.25 }
            : { stroke: "var(--fg-muted)", strokeDasharray: "4 3", strokeWidth: 1 },
      })),
    [layout]
  );

  const selectedType = entityTypes.find((t) => t.name === selected);
  const selectedRelations = selected
    ? edgeTypes.filter((e) => e.domain === selected || e.range === selected)
    : [];
  const subtypes = selected ? entityTypes.filter((t) => t.extends === selected) : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5 mb-1">
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
          ONTOLOGY
        </span>
      </div>
      <h2 className="text-2xl font-semibold tracking-tight">Schema</h2>

      {isLoading && <p className="text-(--fg-muted) text-sm">Loading schema…</p>}

      {!isLoading && entityTypes.length === 0 && (
        <div className="border border-(--border) bg-(--bg-subtle) p-6 space-y-3 max-w-xl">
          <p className="text-sm text-(--fg-muted)">
            No entity types yet. Agents can propose new types via{" "}
            <code className="border border-(--border) bg-(--bg-subtle) px-1 py-0.5 font-mono text-[11px]">
              propose_ontology_change
            </code>
            ; proposals appear in the Inbox for your approval.
          </p>
        </div>
      )}

      {!isLoading && entityTypes.length > 0 && (
        <div className="flex gap-6 items-start">
          {/* Ontology map */}
          <div className="flex-1 min-w-0 space-y-2">
            <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted)">
              Solid lines are inheritance; dashed lines are relations. Click a type for detail.
            </p>
            <div
              className="border border-(--border) bg-(--bg)"
              style={{ height: "calc(100vh - 280px)", minHeight: 420 }}
              data-testid="ontology-map"
            >
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.12, maxZoom: 1.1 }}
                nodesDraggable={false}
                nodesConnectable={false}
                proOptions={{ hideAttribution: true }}
                onNodeClick={(_e, node) => setSelected(selected === node.id ? undefined : node.id)}
                onPaneClick={() => setSelected(undefined)}
              >
                <Background gap={24} size={1} />
              </ReactFlow>
            </div>

            {/* Taxonomy below the map */}
            <section className="pt-4 max-w-xl">
              <h3 className="text-sm font-semibold text-(--fg) mb-2">Taxonomy</h3>
              <p className="text-xs text-(--fg-muted) mb-3">
                Terms label memories inside these types; classification is governed like any other
                write.
              </p>
              <TermOutline terms={terms} pendingTerms={[...pendingTypeNames]} />
            </section>
          </div>

          {/* Detail panel */}
          {selectedType && (
            <aside className="w-96 shrink-0 space-y-3" data-testid="type-detail">
              <TypeCard
                name={selectedType.name}
                pkg={selectedType.package}
                extends={selectedType.extends}
                attributes={normalizeAttributes(selectedType.attributes)}
                pending={pendingTypeNames.has(selectedType.name)}
              />
              {subtypes.length > 0 && (
                <div className="border border-(--border) bg-(--bg-subtle) p-3">
                  <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted) mb-1.5">
                    Extended by
                  </p>
                  <ul className="space-y-1">
                    {subtypes.map((s) => (
                      <li key={s.name}>
                        <button
                          type="button"
                          onClick={() => setSelected(s.name)}
                          className="text-xs text-(--fg) hover:underline"
                        >
                          {s.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {selectedRelations.length > 0 && (
                <div className="border border-(--border) bg-(--bg-subtle) p-3">
                  <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted) mb-1.5">
                    Relations
                  </p>
                  <ul className="space-y-1">
                    {selectedRelations.map((r) => (
                      <li key={r.name} className="text-xs text-(--fg)">
                        <span className="font-mono">{r.name.split("/").pop()}</span>
                        <span className="text-(--fg-muted)">
                          {" "}
                          — {r.domain?.split("/").pop()} → {r.range?.split("/").pop()}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
