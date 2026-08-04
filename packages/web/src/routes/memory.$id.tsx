import { createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { CommitStep } from "~/components/CommitStep";
import { ConnectionsPanel, type EdgeView } from "~/components/ConnectionsPanel";
import { DocEditor } from "~/components/DocEditor";
import { LineageTrail } from "~/components/LineageTrail";
import { MarkdownView } from "~/components/MarkdownView";
import { ProvenanceFooter } from "~/components/ProvenanceFooter";
import type { StatusKind } from "~/components/StatusChip";
import { ApiError } from "~/lib/api";
import { useEntity, useMemoryIndex, useSession, useUpdateMemory } from "~/lib/hooks";
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
  rev?: string;
  classifications?: string[];
  edges?: EdgeView[];
  provenance?: unknown;
  revisions?: Array<{ hash: string; timestamp?: string }>;
}

/** Props accepted by the page component. `entityId` lets tests bypass the router. */
export interface MemoryDetailPageProps {
  entityId?: string;
}

/** Prose body of a node, when it has one, with the attribute key it lives in. */
export function proseOf(
  attributes: Record<string, unknown>
): { key: "content" | "statement"; text: string } | undefined {
  if (typeof attributes.content === "string" && attributes.content.trim())
    return { key: "content", text: attributes.content };
  if (typeof attributes.statement === "string" && attributes.statement.trim())
    return { key: "statement", text: attributes.statement };
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
    const first = prose.text
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

/** Field-per-attribute editor for entities without a prose body. */
function PropertiesEditor({
  attributes,
  onSave,
  onCancel,
}: {
  attributes: Record<string, unknown>;
  onSave: (next: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [fields, setFields] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(attributes).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])
    )
  );

  function save() {
    const next: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(fields)) {
      const original = attributes[key];
      if (typeof original === "string" || original === undefined) {
        next[key] = raw;
      } else {
        // Non-string attributes round-trip through JSON
        try {
          next[key] = JSON.parse(raw);
        } catch {
          next[key] = raw;
        }
      }
    }
    onSave(next);
  }

  return (
    <div className="space-y-3" data-testid="properties-editor">
      <div className="space-y-2">
        {Object.entries(fields).map(([key, value]) => (
          <label key={key} className="block">
            <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted) mb-1">
              {key}
            </span>
            <textarea
              value={value}
              rows={value.includes("\n") ? 4 : 1}
              onChange={(e) => setFields((prev) => ({ ...prev, [key]: e.target.value }))}
              className="w-full border border-(--border) bg-(--bg-subtle) px-2.5 py-1.5 text-sm text-(--fg) focus:outline-none focus:ring-1 focus:ring-(--border)"
            />
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          className="border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--color-accent-fg)] hover:opacity-90"
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="border border-(--border) px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted) hover:text-(--fg)"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

type Mode =
  | { kind: "read" }
  | { kind: "edit" }
  | { kind: "commit"; draftAttributes: Record<string, unknown>; conflict: boolean; error?: string }
  | { kind: "pending"; hash: string };

function serializeAttrs(attributes: Record<string, unknown>): string {
  return JSON.stringify(attributes, null, 2);
}

/** The page component — exported so tests can render it directly without a router. */
export function MemoryDetailPage({ entityId }: MemoryDetailPageProps) {
  const { data, isLoading, refetch } = useEntity(entityId);
  const { data: indexData } = useMemoryIndex();
  const { data: sessionData } = useSession();
  const update = useUpdateMemory(entityId);
  const [mode, setMode] = useState<Mode>({ kind: "read" });

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
  const owner = (sessionData as { owner?: string } | undefined)?.owner ?? "owner";

  const titles = new Map<string, string>(
    (indexData?.results ?? []).map((e) => [e.id, e.title] as [string, string])
  );

  const properties = Object.fromEntries(
    Object.entries(attributes).filter(([key]) => {
      if (prose && key === prose.key) return false;
      if (key === "title" || key === "name") return false;
      return true;
    })
  );

  async function commit(draftAttributes: Record<string, unknown>) {
    if (!entity?.type) return;
    try {
      const result = await update.mutateAsync({
        agent: owner,
        type: entity.type,
        attributes: draftAttributes,
        prior: entity.rev,
      });
      if (result.status === "pending") {
        setMode({ kind: "pending", hash: result.hash });
      } else {
        setMode({ kind: "read" });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // The node changed under us: reload the base, keep the draft, re-diff
        await refetch();
        setMode({ kind: "commit", draftAttributes, conflict: true });
      } else {
        setMode({
          kind: "commit",
          draftAttributes,
          conflict: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  function renderContentLayer() {
    if (mode.kind === "edit") {
      if (prose) {
        return (
          <DocEditor
            initial={prose.text}
            onSave={(next) =>
              setMode({
                kind: "commit",
                draftAttributes: { ...attributes, [prose.key]: next },
                conflict: false,
              })
            }
            onCancel={() => setMode({ kind: "read" })}
          />
        );
      }
      return (
        <PropertiesEditor
          attributes={attributes}
          onSave={(next) => setMode({ kind: "commit", draftAttributes: next, conflict: false })}
          onCancel={() => setMode({ kind: "read" })}
        />
      );
    }

    if (mode.kind === "commit") {
      const draftProse = prose ? mode.draftAttributes[prose.key] : undefined;
      const isProseDiff = prose && typeof draftProse === "string";
      return (
        <CommitStep
          oldText={isProseDiff ? prose.text : serializeAttrs(attributes)}
          newText={isProseDiff ? (draftProse as string) : serializeAttrs(mode.draftAttributes)}
          name={isProseDiff ? "memory.md" : "attributes.json"}
          conflictNotice={mode.conflict}
          errorMessage={mode.error}
          committing={update.isPending}
          onCommit={() => commit(mode.draftAttributes)}
          onKeepEditing={() => setMode({ kind: "edit" })}
        />
      );
    }

    if (mode.kind === "pending") {
      return (
        <CommitStep
          oldText=""
          newText=""
          pendingHash={mode.hash}
          onCommit={() => {}}
          onKeepEditing={() => setMode({ kind: "read" })}
        />
      );
    }

    // Read mode
    return prose ? (
      <section data-testid="memory-content">
        <MarkdownView>{prose.text}</MarkdownView>
      </section>
    ) : (
      <section data-testid="memory-properties">
        <PropertiesTable attributes={attributes} />
      </section>
    );
  }

  return (
    <article className="max-w-3xl space-y-8 reg-marks relative">
      <header>
        <div className="flex items-center justify-between gap-3 mb-1">
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
              {typeLabel || "MEMORY"}
            </span>
          </div>
          {mode.kind === "read" && (
            <button
              type="button"
              onClick={() => setMode({ kind: "edit" })}
              data-testid="edit-button"
              className="border border-(--border) px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted) hover:text-(--fg)"
            >
              Edit
            </button>
          )}
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

      {/* Content layer: read / edit / commit */}
      {renderContentLayer()}

      {/* Remaining properties under prose (read mode only) */}
      {mode.kind === "read" && prose && Object.keys(properties).length > 0 && (
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
