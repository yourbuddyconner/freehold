import { createRoute } from "@tanstack/react-router";
import { ConnectionsPanel, type EdgeView } from "~/components/ConnectionsPanel";
import { LineageTrail } from "~/components/LineageTrail";
import { MarkdownView } from "~/components/MarkdownView";
import { ProvenanceFooter } from "~/components/ProvenanceFooter";
import type { StatusKind } from "~/components/StatusChip";
import { useEntity, useMemoryIndex } from "~/lib/hooks";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/memory/$id",
  component: MemoryDetailRoute,
});

// Real API shape from GET /api/v1/entities/:id → EntityView
interface EntityData {
  attributes?: Record<string, unknown>;
  type?: string;
  classifications?: string[];
  edges?: EdgeView[];
  provenance?: unknown;
  revisions?: Array<{ hash: string; timestamp?: string }>;
}

/** Props accepted by the page component. `entityId` lets tests bypass the router. */
export interface MemoryDetailPageProps {
  entityId?: string;
}

/** Prose body of a node, when it has one. */
export function proseOf(attributes: Record<string, unknown>): string | undefined {
  if (typeof attributes.content === "string" && attributes.content.trim())
    return attributes.content;
  if (typeof attributes.statement === "string" && attributes.statement.trim())
    return attributes.statement;
  return undefined;
}

/** Display title: title → name → first prose line → id. */
function titleOf(attributes: Record<string, unknown>, fallback: string): string {
  for (const key of ["title", "name"]) {
    const v = attributes[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const prose = proseOf(attributes);
  if (prose) {
    const first = prose
      .trim()
      .split("\n")[0]
      .replace(/^#+\s*/, "")
      .trim();
    if (first) return first.length > 80 ? `${first.slice(0, 80)}…` : first;
  }
  return fallback;
}

function PropertiesTable({ attributes }: { attributes: Record<string, unknown> }) {
  const entries = Object.entries(attributes);
  if (entries.length === 0) return null;
  return (
    <table className="w-full text-xs border-collapse">
      <tbody>
        {entries.map(([key, val]) => (
          <tr key={key} className="border-b border-(--border)">
            <td className="py-1.5 pr-4 font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted) w-1/3 align-top">
              {key}
            </td>
            <td className="py-1.5 text-(--fg) text-sm">
              {typeof val === "string" ? val : JSON.stringify(val)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The page component — exported so tests can render it directly without a router. */
export function MemoryDetailPage({ entityId }: MemoryDetailPageProps) {
  const { data, isLoading } = useEntity(entityId);
  const { data: indexData } = useMemoryIndex();
  const entity = data as EntityData | undefined;

  if (isLoading) {
    return <p className="text-sm text-(--fg-muted)">Loading…</p>;
  }

  if (!entity) {
    return <p className="text-sm text-(--fg-muted)">Entity not found.</p>;
  }

  const attributes = entity.attributes ?? {};
  const classifications = entity.classifications ?? [];
  const edges = entity.edges ?? [];
  const prose = proseOf(attributes);
  const title = titleOf(attributes, entityId ?? "Untitled");
  const typeLabel = (entity.type ?? "").split("@")[0];

  // Peer titles for the connections panel, from the workspace index
  const titles = new Map<string, string>(
    (indexData?.results ?? []).map((e) => [e.id, e.title] as [string, string])
  );

  // Properties: everything that is not the prose body
  const properties = Object.fromEntries(
    Object.entries(attributes).filter(([key]) => {
      if (prose && (key === "content" || key === "statement")) return false;
      if (key === "title" || key === "name") return false;
      return true;
    })
  );

  return (
    <article className="max-w-2xl space-y-8 reg-marks relative">
      <header>
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
            {typeLabel || "MEMORY"}
          </span>
        </div>
        <h2 className="text-2xl font-semibold tracking-tight mb-2">{title}</h2>
        {classifications.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {classifications.map((c) => (
              <span
                key={c}
                className="inline-flex items-center border border-(--border) bg-(--bg-subtle) px-1.5 py-0.5 text-[11px] font-mono text-(--fg-muted)"
              >
                {c.split("@")[0]}
              </span>
            ))}
          </div>
        )}
      </header>

      {/* Content layer */}
      {prose ? (
        <section data-testid="memory-content">
          <MarkdownView>{prose}</MarkdownView>
        </section>
      ) : (
        <section data-testid="memory-properties">
          <PropertiesTable attributes={attributes} />
        </section>
      )}

      {/* Remaining properties under prose */}
      {prose && Object.keys(properties).length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-(--fg) mb-2">Properties</h3>
          <PropertiesTable attributes={properties} />
        </section>
      )}

      <ConnectionsPanel edges={edges} titles={titles} />

      {/* Revision history */}
      {entity.revisions && entity.revisions.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-(--fg) mb-2">History</h3>
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
      <span className="reg-mark-bl" aria-hidden />
      <span className="reg-mark-br" aria-hidden />
    </article>
  );
}

/** Router-wired wrapper — reads id from route params. */
function MemoryDetailRoute() {
  const { id } = Route.useParams();
  return <MemoryDetailPage entityId={id} />;
}
