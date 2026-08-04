import { createRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { LineageTrail } from "~/components/LineageTrail";
import { ProvenanceFooter } from "~/components/ProvenanceFooter";
import type { StatusKind } from "~/components/StatusChip";
import { useEntity } from "~/lib/hooks";
import { Route as RootRoute } from "./__root";

// Route definition — will be picked up when TanStack Router regenerates the tree.
// NOT currently in routeTree.gen.ts (auto-generated file is not edited manually).
export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/memory/$id",
  component: MemoryDetailRoute,
});

// Real API shape from GET /api/v1/entities/:id → EntityView
interface EdgeView {
  id: string;
  type: string;
  from: string;
  to: string;
  direction: "outgoing" | "incoming";
  attributes?: Record<string, unknown>;
}

interface EntityData {
  attributes?: Record<string, unknown>;
  type?: string;
  classifications?: string[];
  // API returns a flat EdgeView[] (not {in, out} sub-objects)
  edges?: EdgeView[];
  provenance?: unknown;
  revisions?: Array<{ hash: string; timestamp?: string }>;
}

/** Props accepted by the page component. `entityId` lets tests bypass the router. */
export interface MemoryDetailPageProps {
  entityId?: string;
}

/** The page component — exported so tests can render it directly without a router. */
export function MemoryDetailPage({ entityId }: MemoryDetailPageProps) {
  const { data, isLoading } = useEntity(entityId);
  const entity = data as EntityData | undefined;

  if (isLoading) {
    return <p className="text-sm text-[--fg-muted]">Loading…</p>;
  }

  if (!entity) {
    return <p className="text-sm text-[--fg-muted]">Entity not found.</p>;
  }

  const attributes = entity.attributes ?? {};
  const classifications = entity.classifications ?? [];
  // API returns a flat EdgeView[] with direction "outgoing"/"incoming" and from/to bare prefixed IDs
  const rawEdges = entity.edges ?? [];
  const allEdges = rawEdges.map((e) => ({
    type: e.type,
    direction: e.direction === "outgoing" ? ("Out" as const) : ("In" as const),
    // targetId: for outgoing edges the peer is `to`, for incoming edges the peer is `from`
    targetId: (() => {
      const raw = e.direction === "outgoing" ? e.to : e.from;
      const idx = raw.indexOf(":");
      return idx >= 0 ? raw.slice(idx + 1) : raw;
    })(),
  }));
  const edgesByType: Record<string, typeof allEdges> = {};
  for (const edge of allEdges) {
    const bucket = edgesByType[edge.type] ?? [];
    bucket.push(edge);
    edgesByType[edge.type] = bucket;
  }

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h2 className="font-serif text-2xl font-semibold mb-1">Entity detail</h2>
        {entity.type && (
          <span className="inline-flex items-center rounded border border-[--border] px-1.5 py-0.5 text-[11px] font-mono text-[--fg-muted]">
            {entity.type}
          </span>
        )}
      </div>

      {/* Attributes */}
      {Object.keys(attributes).length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-[--fg] mb-2">Attributes</h3>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-[--border]">
                <th className="text-left py-1 pr-4 font-medium text-[--fg-muted] w-1/3">Key</th>
                <th className="text-left py-1 font-medium text-[--fg-muted]">Value</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(attributes).map(([key, val]) => (
                <tr key={key} className="border-b border-[--border]">
                  <td className="py-1.5 pr-4 font-mono text-[--fg-muted]">{key}</td>
                  <td className="py-1.5 text-[--fg] font-mono">
                    {typeof val === "string" ? val : JSON.stringify(val)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Classifications */}
      {classifications.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-[--fg] mb-2">Classifications</h3>
          <div className="flex flex-wrap gap-1.5">
            {classifications.map((c) => (
              <span
                key={c}
                className="inline-flex items-center rounded border border-[--border] bg-[--bg-subtle] px-1.5 py-0.5 text-[11px] font-mono text-[--fg-muted]"
              >
                {c}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Edges */}
      {allEdges.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-[--fg] mb-2">Edges</h3>
          <div className="space-y-3">
            {(Object.entries(edgesByType) as [string, typeof allEdges][]).map(
              ([edgeType, edges]) => (
                <div key={edgeType}>
                  <p className="text-xs font-medium text-[--fg-muted] mb-1 font-mono">{edgeType}</p>
                  <ul className="space-y-1 pl-3 border-l border-[--border]">
                    {edges.map((edge) => (
                      <li
                        key={`${edge.direction}-${edge.targetId}`}
                        className="flex items-center gap-2 text-xs"
                      >
                        <span className="rounded bg-neutral-100 dark:bg-neutral-800 px-1 py-0.5 text-[10px] font-medium">
                          {edge.direction}
                        </span>
                        <Link
                          to="/memory/$id"
                          params={{ id: edge.targetId }}
                          className="font-mono text-[--fg] hover:underline"
                        >
                          {edge.targetId}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            )}
          </div>
        </section>
      )}

      {/* Revision history */}
      {entity.revisions && entity.revisions.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-[--fg] mb-2">Revision history</h3>
          <LineageTrail revisions={entity.revisions} />
        </section>
      )}

      {/* Provenance */}
      {entity.provenance != null &&
        (() => {
          const prov = entity.provenance as Record<string, unknown>;
          const author =
            typeof prov.derived_by === "string"
              ? prov.derived_by.replace("principal:", "")
              : typeof prov.author === "string"
                ? prov.author
                : "";
          const method = typeof prov.method === "string" ? prov.method : "model-assisted";
          // Entities returned by getEntity are admitted (live in graph state).
          // Approval status is therefore "approved" — shown with the StatusChip colour.
          const approvalStatus: StatusKind = "approved";
          return (
            <ProvenanceFooter
              author={author}
              method={method}
              approvalLabel="Approved"
              approvalStatus={approvalStatus}
              changesetHash={typeof prov.changeset === "string" ? prov.changeset : undefined}
            />
          );
        })()}
    </div>
  );
}

/** Router-wired wrapper — reads id from route params. */
function MemoryDetailRoute() {
  const { id } = Route.useParams();
  return <MemoryDetailPage entityId={id} />;
}
