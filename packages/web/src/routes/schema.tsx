import { createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { TermOutline } from "~/components/TermOutline";
import { usePending, useSchema } from "~/lib/hooks";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/schema",
  component: SchemaPage,
});

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

interface EntityTypeRaw {
  name: string;
  package?: string;
  attributes?: Record<string, unknown>;
  extends?: string;
}

interface EdgeTypeRaw {
  name: string;
  domain?: string;
  range?: string;
}

interface AttrView {
  name: string;
  type: string;
  required: boolean;
}

function shortName(ref: string): string {
  return ref.split("/").pop() ?? ref;
}

function pkgOf(t: EntityTypeRaw): string {
  return t.package ?? t.name.split("/")[0];
}

function normalizeAttributes(raw: Record<string, unknown> | undefined): AttrView[] {
  if (!raw) return [];
  return Object.entries(raw)
    .map(([name, val]) => {
      if (typeof val === "object" && val !== null) {
        const obj = val as Record<string, unknown>;
        return {
          name,
          type: typeof obj.type === "string" ? obj.type : JSON.stringify(val),
          required: obj.required === true,
        };
      }
      return { name, type: typeof val === "string" ? val : JSON.stringify(val), required: false };
    })
    .sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name));
}

/** Walk the extends chain, nearest parent first. */
function ancestorsOf(t: EntityTypeRaw, byName: Map<string, EntityTypeRaw>): EntityTypeRaw[] {
  const chain: EntityTypeRaw[] = [];
  let cur = t.extends ? byName.get(t.extends) : undefined;
  const guard = new Set<string>([t.name]);
  while (cur && !guard.has(cur.name)) {
    chain.push(cur);
    guard.add(cur.name);
    cur = cur.extends ? byName.get(cur.extends) : undefined;
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Left index: packages → types, subtypes indented under their parent
// ---------------------------------------------------------------------------

interface IndexRow {
  type: EntityTypeRaw;
  depth: number;
}

/** Package → ordered rows with subtypes directly under their parents. */
function buildIndex(types: EntityTypeRaw[]): Map<string, IndexRow[]> {
  const byName = new Map(types.map((t) => [t.name, t]));
  const children = new Map<string, EntityTypeRaw[]>();
  const roots: EntityTypeRaw[] = [];
  for (const t of [...types].sort((a, b) => a.name.localeCompare(b.name))) {
    if (t.extends && byName.has(t.extends)) {
      const list = children.get(t.extends) ?? [];
      list.push(t);
      children.set(t.extends, list);
    } else {
      roots.push(t);
    }
  }

  // Group by the ROOT's package; a subtype files under its parent even when
  // it lives in another package (its own package shows in the row).
  const index = new Map<string, IndexRow[]>();
  function push(pkg: string, t: EntityTypeRaw, depth: number) {
    const rows = index.get(pkg) ?? [];
    rows.push({ type: t, depth });
    index.set(pkg, rows);
    for (const kid of children.get(t.name) ?? []) {
      push(pkg, kid, depth + 1);
    }
  }
  for (const r of roots) {
    push(pkgOf(r), r, 0);
  }
  return new Map([...index.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function SchemaPage() {
  const { data: schema, isLoading } = useSchema();
  const { data: pendingData } = usePending();
  const [selectedName, setSelectedName] = useState<string | undefined>();

  const entityTypes: EntityTypeRaw[] = schema?.entityTypes ?? [];
  const edgeTypes: EdgeTypeRaw[] = schema?.edgeTypes ?? [];
  const terms = schema?.terms ?? [];

  const pendingProposals = (pendingData?.proposals ?? []).filter((p) => p.isSchemaProposal);
  const pendingTypeNames = new Set(pendingProposals.flatMap((p) => p.diff.map((d) => d.key)));

  const byName = new Map(entityTypes.map((t) => [t.name, t]));
  const index = buildIndex(entityTypes);
  const firstType = [...index.values()][0]?.[0]?.type.name;
  const selected = selectedName ?? firstType;
  const selectedType = selected ? byName.get(selected) : undefined;

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
          SCHEMA REFERENCE
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
        <>
          <div className="flex gap-8 items-start">
            {/* Type index */}
            <nav
              aria-label="Type index"
              className="w-60 shrink-0 space-y-4"
              data-testid="type-index"
            >
              {[...index.entries()].map(([pkg, rows]) => (
                <div key={pkg}>
                  <p className="border-b border-(--border) pb-1 mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted)">
                    {pkg} <span className="opacity-60">· {rows.length}</span>
                  </p>
                  <ul>
                    {rows.map(({ type, depth }) => {
                      const active = selected === type.name;
                      return (
                        <li key={type.name}>
                          <button
                            type="button"
                            onClick={() => setSelectedName(type.name)}
                            data-testid={`index-${type.name}`}
                            className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-[13px] ${
                              active
                                ? "nav-active-marker bg-(--bg-subtle)"
                                : "text-(--fg-muted) hover:text-(--fg) hover:bg-(--bg-subtle)"
                            }`}
                            style={{ paddingLeft: 8 + depth * 14 }}
                          >
                            {depth > 0 && (
                              <span aria-hidden className="font-mono text-[10px] text-(--fg-muted)">
                                └
                              </span>
                            )}
                            <span className="truncate">{shortName(type.name)}</span>
                            {pendingTypeNames.has(type.name) && (
                              <span
                                title="Pending"
                                className="ml-auto inline-block h-1.5 w-1.5 shrink-0 bg-[var(--color-status-pending)]"
                              />
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </nav>

            {/* Spec sheet */}
            {selectedType && (
              <TypeSpecSheet
                type={selectedType}
                byName={byName}
                allTypes={entityTypes}
                edgeTypes={edgeTypes}
                pending={pendingTypeNames.has(selectedType.name)}
                onSelect={setSelectedName}
              />
            )}
          </div>

          {/* Relations + taxonomy reference */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 pt-6 border-t border-(--border)">
            <section data-testid="relations-index">
              <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted) mb-2">
                Relations · {edgeTypes.length}
              </h3>
              {edgeTypes.length === 0 ? (
                <p className="text-xs text-(--fg-muted)">No edge types defined yet.</p>
              ) : (
                <table className="w-full text-xs border-collapse">
                  <tbody>
                    {edgeTypes.map((e) => (
                      <tr key={e.name} className="border-b border-(--border)">
                        <td className="py-1.5 pr-3 font-mono text-(--fg)">{shortName(e.name)}</td>
                        <td className="py-1.5 text-(--fg-muted)">
                          {e.domain ? (
                            <TypeLink name={e.domain} byName={byName} onSelect={setSelectedName} />
                          ) : (
                            "any"
                          )}
                          <span className="px-1.5 font-mono">→</span>
                          {e.range ? (
                            <TypeLink name={e.range} byName={byName} onSelect={setSelectedName} />
                          ) : (
                            "any"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section>
              <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted) mb-2">
                Taxonomy · {terms.length}
              </h3>
              <p className="text-xs text-(--fg-muted) mb-3">
                Terms label memories inside these types; classification is governed like any other
                write.
              </p>
              <TermOutline terms={terms} pendingTerms={[...pendingTypeNames]} />
            </section>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spec sheet
// ---------------------------------------------------------------------------

function TypeLink({
  name,
  byName,
  onSelect,
}: {
  name: string;
  byName: Map<string, EntityTypeRaw>;
  onSelect: (name: string) => void;
}) {
  if (!byName.has(name)) return <span className="font-mono">{shortName(name)}</span>;
  return (
    <button
      type="button"
      onClick={() => onSelect(name)}
      className="font-mono text-(--fg) underline underline-offset-2 decoration-(--border) hover:decoration-[var(--color-accent)]"
    >
      {shortName(name)}
    </button>
  );
}

function AttrTable({ attrs, muted = false }: { attrs: AttrView[]; muted?: boolean }) {
  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="border-b border-(--border)">
          <th className="py-1 pr-4 text-left font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted) font-normal w-2/5">
            Attribute
          </th>
          <th className="py-1 pr-4 text-left font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted) font-normal">
            Type
          </th>
          <th className="py-1 text-left font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted) font-normal w-20">
            Required
          </th>
        </tr>
      </thead>
      <tbody>
        {attrs.map((a) => (
          <tr key={a.name} className="border-b border-(--border)">
            <td
              className={`py-1.5 pr-4 font-mono text-[13px] ${muted ? "text-(--fg-muted)" : "text-(--fg)"}`}
            >
              {a.name}
            </td>
            <td className="py-1.5 pr-4 font-mono text-[12px] text-(--fg-muted)">{a.type}</td>
            <td className="py-1.5">
              {a.required ? (
                <span className="inline-block border border-[var(--color-accent)] bg-[var(--color-accent)] px-1 font-mono text-[9px] uppercase tracking-wide text-[var(--color-accent-fg)]">
                  req
                </span>
              ) : (
                <span className="font-mono text-[11px] text-(--fg-muted)">—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface TypeSpecSheetProps {
  type: EntityTypeRaw;
  byName: Map<string, EntityTypeRaw>;
  allTypes: EntityTypeRaw[];
  edgeTypes: EdgeTypeRaw[];
  pending: boolean;
  onSelect: (name: string) => void;
}

function TypeSpecSheet({
  type,
  byName,
  allTypes,
  edgeTypes,
  pending,
  onSelect,
}: TypeSpecSheetProps) {
  const ancestors = ancestorsOf(type, byName);
  // The schema flattens inherited attributes into each type; show only the
  // type's own additions here — the inherited sections carry the rest.
  const inheritedNames = new Set(ancestors.flatMap((a) => Object.keys(a.attributes ?? {})));
  const own = normalizeAttributes(type.attributes).filter((a) => !inheritedNames.has(a.name));
  const subtypes = allTypes.filter((t) => t.extends === type.name);
  const relations = edgeTypes.filter((e) => e.domain === type.name || e.range === type.name);

  return (
    <article
      className={`flex-1 min-w-0 max-w-2xl space-y-6 reg-marks relative ${pending ? "pending-border p-5" : ""}`}
      data-testid="type-detail"
    >
      <header>
        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted)">
          {pkgOf(type)}
          {pending && (
            <span className="ml-2 text-[var(--color-status-pending)]">· pending proposal</span>
          )}
        </p>
        <h3 className="mt-0.5 text-3xl font-semibold tracking-tight">{shortName(type.name)}</h3>
        <p className="mt-1 font-mono text-[12px] text-(--fg-muted)">
          {type.name}
          {ancestors.map((a) => (
            <span key={a.name}>
              {" "}
              <span aria-hidden>←</span>{" "}
              <TypeLink name={a.name} byName={byName} onSelect={onSelect} />
            </span>
          ))}
        </p>
      </header>

      <section>
        <h4 className="font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted) mb-2">
          Attributes · {own.length}
        </h4>
        {own.length > 0 ? (
          <AttrTable attrs={own} />
        ) : (
          <p className="text-xs text-(--fg-muted)">No attributes of its own.</p>
        )}
      </section>

      {ancestors.map((a) => {
        const inherited = normalizeAttributes(a.attributes);
        if (inherited.length === 0) return null;
        return (
          <section key={a.name} data-testid={`inherited-${a.name}`}>
            <h4 className="font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted) mb-2">
              Inherited from <TypeLink name={a.name} byName={byName} onSelect={onSelect} /> ·{" "}
              {inherited.length}
            </h4>
            <AttrTable attrs={inherited} muted />
          </section>
        );
      })}

      {subtypes.length > 0 && (
        <section>
          <h4 className="font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted) mb-2">
            Extended by · {subtypes.length}
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {subtypes.map((s) => (
              <button
                key={s.name}
                type="button"
                onClick={() => onSelect(s.name)}
                className="border border-(--border) bg-(--bg-subtle) px-2 py-0.5 font-mono text-[11px] text-(--fg) hover:border-[var(--color-accent)]"
              >
                {shortName(s.name)}
              </button>
            ))}
          </div>
        </section>
      )}

      {relations.length > 0 && (
        <section>
          <h4 className="font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted) mb-2">
            Relations · {relations.length}
          </h4>
          <ul className="space-y-1">
            {relations.map((r) => {
              const outgoing = r.domain === type.name;
              const peer = outgoing ? r.range : r.domain;
              return (
                <li key={r.name} className="flex items-baseline gap-2 text-sm">
                  <span className="font-mono text-[12px] text-(--fg)">{shortName(r.name)}</span>
                  <span className="text-xs text-(--fg-muted)">
                    {outgoing ? "→" : "←"}{" "}
                    {peer ? <TypeLink name={peer} byName={byName} onSelect={onSelect} /> : "any"}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <span className="reg-mark-bl" aria-hidden />
      <span className="reg-mark-br" aria-hidden />
    </article>
  );
}
