import { createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { EdgeTypeTable } from "~/components/EdgeTypeTable";
import { TermOutline } from "~/components/TermOutline";
import { TypeCard } from "~/components/TypeCard";
import { cn } from "~/lib/cn";
import { usePending, useSchema } from "~/lib/hooks";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/schema",
  component: SchemaPage,
});

type Tab = "types" | "edges" | "taxonomy";

function SchemaPage() {
  const [tab, setTab] = useState<Tab>("types");
  const { data: schema, isLoading } = useSchema();
  const { data: pendingData } = usePending();

  const entityTypes = schema?.entityTypes ?? [];
  const edgeTypes = schema?.edgeTypes ?? [];
  const terms = schema?.terms ?? [];

  // Pending schema proposals — identify which entity types are pending
  const pendingProposals = (pendingData?.proposals ?? []).filter((p) => p.isSchemaProposal);
  const pendingTypeNames = new Set(pendingProposals.flatMap((p) => p.diff.map((d) => d.key)));

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
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-[--fg-muted]">
          SCHEMA VIEWER
        </span>
      </div>
      <h2 className="text-2xl font-semibold tracking-tight">Schema</h2>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-[--border]">
        {(["types", "edges", "taxonomy"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              "px-4 py-2 border-b-2 -mb-px font-mono text-[11px] uppercase tracking-[0.06em] transition-colors",
              tab === t
                ? "border-[var(--color-accent)] text-[--fg] font-medium"
                : "border-transparent text-[--fg-muted] hover:text-[--fg]"
            )}
          >
            {t}
            {t === "types" && pendingTypeNames.size > 0 && (
              <span className="ml-1.5 bg-amber-500 text-white text-[10px] px-1.5 py-0.5 font-bold">
                {pendingTypeNames.size}
              </span>
            )}
          </button>
        ))}
      </div>

      {isLoading && <p className="text-[--fg-muted] text-sm">Loading schema…</p>}

      {!isLoading && tab === "types" && (
        <TypesTab
          entityTypes={entityTypes}
          pendingTypeNames={pendingTypeNames}
          pendingProposals={pendingProposals}
        />
      )}

      {!isLoading && tab === "edges" && <EdgesTab edgeTypes={edgeTypes} />}

      {!isLoading && tab === "taxonomy" && (
        <TaxonomyTab terms={terms} pendingTypeNames={pendingTypeNames} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Types tab
// ---------------------------------------------------------------------------

interface EntityTypeRaw {
  name: string;
  package?: string;
  attributes?: Record<string, unknown>;
  extends?: string;
}

interface PendingProposal {
  hash: string;
  agent: string;
  diff: { key: string; before?: unknown; after?: unknown }[];
}

interface TypesTabProps {
  entityTypes: EntityTypeRaw[];
  pendingTypeNames: Set<string>;
  pendingProposals: PendingProposal[];
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

function TypesTab({ entityTypes, pendingTypeNames, pendingProposals }: TypesTabProps) {
  if (entityTypes.length === 0 && pendingTypeNames.size === 0) {
    return (
      <div className="border border-[--border] bg-[--bg-subtle] p-6 space-y-3 max-w-xl">
        <p className="text-sm text-[--fg-muted]">
          No entity types yet. Agents can propose new types via{" "}
          <code className="border border-[--border] bg-[--bg-subtle] px-1 py-0.5 font-mono text-[11px]">
            propose_ontology_change
          </code>
          ; proposals appear in the Inbox for your approval.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 max-w-2xl">
      {entityTypes.map((et, index) => (
        <div key={et.name} className={`reveal reveal-${(index % 6) + 1}`}>
          <TypeCard
            name={et.name}
            pkg={et.package}
            extends={et.extends}
            attributes={normalizeAttributes(et.attributes)}
            pending={pendingTypeNames.has(et.name)}
          />
        </div>
      ))}

      {/* Render pending proposals that aren't yet in the schema */}
      {pendingProposals
        .flatMap((p) => p.diff)
        .filter((d) => !entityTypes.some((et) => et.name === d.key))
        .map((d) => {
          const after =
            typeof d.after === "object" && d.after !== null
              ? (d.after as Record<string, unknown>)
              : {};
          return (
            <TypeCard
              key={d.key}
              name={d.key}
              extends={typeof after.extends === "string" ? after.extends : undefined}
              attributes={normalizeAttributes(
                typeof after.attributes === "object" && after.attributes !== null
                  ? (after.attributes as Record<string, unknown>)
                  : undefined
              )}
              pending
            />
          );
        })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edges tab
// ---------------------------------------------------------------------------

interface EdgesTabProps {
  edgeTypes: { name: string; domain?: string; range?: string }[];
}

function EdgesTab({ edgeTypes }: EdgesTabProps) {
  return (
    <div className="max-w-2xl">
      <EdgeTypeTable edgeTypes={edgeTypes} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Taxonomy tab
// ---------------------------------------------------------------------------

interface TaxonomyTabProps {
  terms: { name: string; parent?: string }[];
  pendingTypeNames: Set<string>;
}

function TaxonomyTab({ terms, pendingTypeNames }: TaxonomyTabProps) {
  return (
    <div className="max-w-xl">
      <TermOutline terms={terms} pendingTerms={[...pendingTypeNames]} />
    </div>
  );
}
