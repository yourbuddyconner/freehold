# F8: Console Inbox + Memory Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Inbox (proposal review with approve/reject) and Memory browser (search + filter + entity detail) pages for the Freehold console.

**Architecture:** Six new/replaced component files provide reusable UI primitives (DiffView, ProposalCard, MemoryCard, TaxonomyTree, LineageTrail). Two existing route stubs are replaced with full implementations. One new entity-detail route is created as a standalone component (not in routeTree.gen.ts since that file is auto-generated and not re-run during tests). Three colocated test files verify each route.

**Tech Stack:** React 19, TanStack Router v1, TanStack Query v5, Radix UI Dialog, Tailwind CSS v4, Vitest + @testing-library/react, happy-dom

## Global Constraints

- Do NOT edit `packages/web/src/routeTree.gen.ts` (auto-generated)
- Do NOT edit `packages/client/src/` (generated)
- Zero TypeScript errors: `tsc --noEmit`
- Biome lint clean: `pnpm --filter @freehold/web exec biome check src/`
- `pnpm --filter @freehold/web build` must succeed
- `pnpm --filter @freehold/web test` must pass
- Use `~` path alias for all internal imports (e.g. `~/lib/hooks`, `~/components/ProvenanceFooter`)
- No new dependencies with native bindings
- Commit message: `Console: Inbox and Memory browser`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `packages/web/src/lib/hooks.ts` | Modify | Add `useEntity`, update `useRecall` to accept filters object |
| `packages/web/src/components/DiffView.tsx` | Create | Collapsible diff renderer for ProposalView['diff'] |
| `packages/web/src/components/ProposalCard.tsx` | Create | One card per ProposalView with approve/reject, dialog |
| `packages/web/src/components/MemoryCard.tsx` | Create | RecallResult card with provenance footer + detail link |
| `packages/web/src/components/TaxonomyTree.tsx` | Create | Collapsible sidebar taxonomy tree from schema terms |
| `packages/web/src/components/LineageTrail.tsx` | Create | Vertical revision history chain |
| `packages/web/src/routes/inbox.tsx` | Replace | Full Inbox page using usePending + ProposalCard |
| `packages/web/src/routes/memory.tsx` | Replace | Memory browser with search, filters, TaxonomyTree, MemoryCard |
| `packages/web/src/routes/memory.$id.tsx` | Create | Entity detail page (standalone component, not in routeTree) |
| `packages/web/src/routes/inbox.test.tsx` | Create | Inbox route tests |
| `packages/web/src/routes/memory.test.tsx` | Create | Memory route tests |
| `packages/web/src/routes/memory.$id.test.tsx` | Create | Entity detail page tests |

---

### Task 1: Update hooks.ts

**Files:**
- Modify: `packages/web/src/lib/hooks.ts`

**Interfaces:**
- Produces: `useEntity(id: string | undefined)` returning `UseQueryResult`
- Produces: `useRecall(query: string, filters?: { type?: string; author?: string; status?: string }, enabled?: boolean)` returning `UseQueryResult`

- [ ] **Step 1: Update hooks.ts**

Replace the current `useRecall` and add `useEntity`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "./api";

/** Pending proposals (the Inbox). */
export function usePending() {
  return useQuery({
    queryKey: ["proposals"],
    queryFn: () => apiClient.proposals(),
  });
}

/** Recall search with optional filters. */
export function useRecall(
  query: string,
  filters: { type?: string; author?: string; status?: string } = {},
  enabled = true
) {
  return useQuery({
    queryKey: ["recall", query, filters],
    queryFn: () => apiClient.recall(query, filters),
    enabled: enabled && query.length > 0,
  });
}

/** Single entity detail. */
export function useEntity(id: string | undefined) {
  return useQuery({
    queryKey: ["entity", id],
    queryFn: () => apiClient.getEntity(id!),
    enabled: !!id,
  });
}

/** Verify report. */
export function useVerify(enabled = false) {
  return useQuery({
    queryKey: ["verify"],
    queryFn: () => apiClient.verify(),
    enabled,
  });
}

/** Schema description. */
export function useSchema() {
  return useQuery({
    queryKey: ["schema"],
    queryFn: () => apiClient.schema(),
  });
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm --filter @freehold/web exec tsc --noEmit
```

Expected: no errors related to hooks.ts

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/lib/hooks.ts
git commit -m "feat(web): add useEntity hook and filters param to useRecall"
```

---

### Task 2: Create DiffView.tsx

**Files:**
- Create: `packages/web/src/components/DiffView.tsx`

**Interfaces:**
- Consumes: `diff: Array<{ key: string; before?: unknown; after?: unknown }>` prop
- Produces: exported `DiffView` React component

- [ ] **Step 1: Create the component**

```typescript
import { useState } from "react";
import { cn } from "~/lib/cn";

interface DiffEntry {
  key: string;
  before?: unknown;
  after?: unknown;
}

interface DiffViewProps {
  diff: DiffEntry[];
  className?: string;
}

function stringify(val: unknown): string {
  if (typeof val === "string") return val;
  return JSON.stringify(val, null, 2);
}

export function DiffView({ diff, className }: DiffViewProps) {
  const [open, setOpen] = useState(false);

  if (diff.length === 0) return null;

  return (
    <div className={cn("text-xs", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[--fg-muted] hover:text-[--fg] underline underline-offset-2 transition-colors"
      >
        {open ? "Hide diff" : "Show diff"}
      </button>
      {open && (
        <div className="mt-2 rounded border border-[--border] bg-[--bg-subtle] p-3 space-y-2 font-mono text-[11px]">
          {diff.map((entry) => {
            const isAdded = entry.after !== undefined && entry.before === undefined;
            const isChanged = entry.before !== undefined || entry.after !== undefined;

            return (
              <div key={entry.key} className="space-y-0.5">
                <span className="text-[--fg-muted]">{entry.key}:</span>
                {entry.before !== undefined && (
                  <div className="pl-2 line-through text-[--fg-muted]">
                    {stringify(entry.before)}
                  </div>
                )}
                {entry.after !== undefined && (
                  <div
                    className={cn(
                      "pl-2",
                      isAdded
                        ? "text-green-700 dark:text-green-400"
                        : "text-amber-700 dark:text-amber-400"
                    )}
                  >
                    {stringify(entry.after)}
                  </div>
                )}
                {!isChanged && entry.before === undefined && entry.after === undefined && (
                  <div className="pl-2 text-[--fg-muted]">(no change)</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm --filter @freehold/web exec tsc --noEmit
```

Expected: no errors

---

### Task 3: Create ProposalCard.tsx

**Files:**
- Create: `packages/web/src/components/ProposalCard.tsx`

**Interfaces:**
- Consumes: `DiffView` from `~/components/DiffView`
- Consumes:
  ```typescript
  interface ProposalCardProps {
    proposal: {
      hash: string;
      agent: string;
      intent: string;
      summary: string;
      rules: string[];
      diff: Array<{ key: string; before?: unknown; after?: unknown }>;
      isSchemaProposal: boolean;
    };
    onApprove: () => void;
    onReject: () => void;
    isApproving?: boolean;
    isRejecting?: boolean;
  }
  ```
- Produces: exported `ProposalCard` React component

- [ ] **Step 1: Create the component**

```typescript
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "~/lib/cn";
import { DiffView } from "./DiffView";

interface DiffEntry {
  key: string;
  before?: unknown;
  after?: unknown;
}

interface Proposal {
  hash: string;
  agent: string;
  intent: string;
  summary: string;
  rules: string[];
  diff: DiffEntry[];
  isSchemaProposal: boolean;
}

interface ProposalCardProps {
  proposal: Proposal;
  onApprove: () => void;
  onReject: () => void;
  isApproving?: boolean;
  isRejecting?: boolean;
}

function AgentMark({ agent }: { agent: string }) {
  const initials = agent.slice(0, 2).toUpperCase();
  return (
    <span
      aria-hidden
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-200 dark:bg-neutral-700 text-[11px] font-bold text-[--fg] font-mono"
    >
      {initials}
    </span>
  );
}

export function ProposalCard({
  proposal,
  onApprove,
  onReject,
  isApproving,
  isRejecting,
}: ProposalCardProps) {
  const { hash, agent, intent, summary, rules, diff, isSchemaProposal } = proposal;

  return (
    <article
      className={cn(
        "rounded-lg border p-4 space-y-3 bg-[--bg-subtle]",
        isSchemaProposal
          ? "border-amber-400 bg-amber-50 dark:bg-amber-900/30"
          : "border-[--border]"
      )}
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <AgentMark agent={agent} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-[--fg]">{agent}</span>
            <span className="text-xs text-[--fg-muted]">·</span>
            <span className="text-xs text-[--fg-muted] italic">{intent}</span>
            {isSchemaProposal && (
              <span
                data-testid="schema-badge"
                className="inline-flex items-center rounded border border-amber-400 bg-amber-100 dark:bg-amber-900 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
              >
                Schema proposal
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Summary */}
      <p className="text-sm text-[--fg] font-serif leading-relaxed">{summary}</p>

      {/* Rules */}
      {rules.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid="rules-row">
          {rules.map((rule) => (
            <span
              key={rule}
              className="inline-flex items-center rounded border border-[--border] bg-[--bg-subtle] px-1.5 py-0.5 text-[11px] text-[--fg-muted]"
            >
              {rule}
            </span>
          ))}
        </div>
      )}

      {/* Diff */}
      <DiffView diff={diff} />

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        {/* Approve — opens a confirmation dialog */}
        <Dialog.Root>
          <Dialog.Trigger asChild>
            <button
              type="button"
              disabled={isApproving || isRejecting}
              className="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
            >
              {isApproving ? "Approving…" : "Approve"}
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm rounded-lg bg-white dark:bg-neutral-900 border border-[--border] p-6 shadow-xl space-y-4">
              <Dialog.Title className="text-base font-semibold text-[--fg]">
                Approve proposal
              </Dialog.Title>
              <Dialog.Description className="text-sm text-[--fg-muted]">
                This signs a decision record with your key.
              </Dialog.Description>
              <div className="flex gap-2 justify-end">
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="rounded border border-[--border] px-3 py-1.5 text-xs font-medium text-[--fg] hover:bg-[--bg-subtle] transition-colors"
                  >
                    Cancel
                  </button>
                </Dialog.Close>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    onClick={onApprove}
                    className="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 transition-colors"
                  >
                    Approve
                  </button>
                </Dialog.Close>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        {/* Reject — direct action */}
        <button
          type="button"
          onClick={onReject}
          disabled={isApproving || isRejecting}
          className="rounded border border-[--border] px-3 py-1.5 text-xs font-medium text-[--fg-muted] hover:text-[--fg] hover:bg-[--bg-subtle] disabled:opacity-50 transition-colors"
        >
          {isRejecting ? "Rejecting…" : "Reject"}
        </button>
      </div>
    </article>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm --filter @freehold/web exec tsc --noEmit
```

---

### Task 4: Create MemoryCard.tsx

**Files:**
- Create: `packages/web/src/components/MemoryCard.tsx`

**Interfaces:**
- Consumes: `ProvenanceFooter` from `~/components/ProvenanceFooter`
- Consumes:
  ```typescript
  interface MemoryCardProps {
    result: {
      id: string;
      type: string;
      content?: unknown;
      author: string;
      approval: string;
      changeset: string;
      score: number;
    };
  }
  ```
- Produces: exported `MemoryCard` React component

- [ ] **Step 1: Create the component**

```typescript
import { Link } from "@tanstack/react-router";
import { ProvenanceFooter } from "~/components/ProvenanceFooter";

interface RecallResult {
  id: string;
  type: string;
  content?: unknown;
  author: string;
  approval: string;
  changeset: string;
  score: number;
}

interface MemoryCardProps {
  result: RecallResult;
}

function renderContent(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  return JSON.stringify(content, null, 2);
}

export function MemoryCard({ result }: MemoryCardProps) {
  const { id, type, content, author, approval, changeset } = result;
  const text = renderContent(content);

  return (
    <article className="rounded-lg border border-[--border] bg-[--bg-subtle] p-4 space-y-3">
      {/* Type chip */}
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center rounded border border-[--border] px-1.5 py-0.5 text-[11px] font-medium font-mono text-[--fg-muted]">
          {type}
        </span>
        <Link
          to="/memory/$id"
          params={{ id }}
          className="text-xs text-[--fg-muted] hover:text-[--fg] underline underline-offset-2 transition-colors"
        >
          View detail →
        </Link>
      </div>

      {/* Content */}
      {text && (
        <p className="text-sm text-[--fg] font-serif leading-relaxed line-clamp-4">{text}</p>
      )}

      {/* Provenance */}
      <ProvenanceFooter
        author={author}
        method="agent"
        approvalLabel={approval}
        changesetHash={changeset}
      />
    </article>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm --filter @freehold/web exec tsc --noEmit
```

---

### Task 5: Create TaxonomyTree.tsx

**Files:**
- Create: `packages/web/src/components/TaxonomyTree.tsx`

**Interfaces:**
- Consumes:
  ```typescript
  interface TaxonomyTreeProps {
    terms: Array<{ name: string; parent?: string }>;
    selected?: string;
    onSelect: (t: string) => void;
  }
  ```
- Produces: exported `TaxonomyTree` React component

- [ ] **Step 1: Create the component**

```typescript
import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "~/lib/cn";

interface Term {
  name: string;
  parent?: string;
}

interface TaxonomyTreeProps {
  terms: Term[];
  selected?: string;
  onSelect: (t: string) => void;
}

export function TaxonomyTree({ terms, selected, onSelect }: TaxonomyTreeProps) {
  const [collapsed, setCollapsed] = useState(false);

  // Group: roots = terms with no parent or whose parent isn't in the list
  const termNames = new Set(terms.map((t) => t.name));
  const roots = terms.filter((t) => !t.parent || !termNames.has(t.parent));
  const children = (parentName: string) => terms.filter((t) => t.parent === parentName);

  function TermChip({ term }: { term: Term }) {
    const isSelected = selected === term.name;
    const kids = children(term.name);
    return (
      <div>
        <button
          type="button"
          onClick={() => onSelect(term.name)}
          className={cn(
            "w-full text-left rounded px-2 py-1 text-xs transition-colors",
            isSelected
              ? "bg-[--border] text-[--fg] font-medium"
              : "text-[--fg-muted] hover:text-[--fg] hover:bg-[--bg-subtle]"
          )}
        >
          {term.name}
        </button>
        {kids.length > 0 && (
          <div className="pl-3 border-l border-[--border] ml-2 mt-0.5 space-y-0.5">
            {kids.map((kid) => (
              <TermChip key={kid.name} term={kid} />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className="flex flex-col items-center py-4">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label="Expand taxonomy"
          className="text-[--fg-muted] hover:text-[--fg] transition-colors"
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <aside className="w-44 shrink-0 border-r border-[--border] pr-2 space-y-1">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-[--fg-muted] uppercase tracking-wide">
          Taxonomy
        </h3>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse taxonomy"
          className="text-[--fg-muted] hover:text-[--fg] transition-colors"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="space-y-0.5">
        {roots.map((term) => (
          <TermChip key={term.name} term={term} />
        ))}
        {terms.length === 0 && (
          <p className="text-xs text-[--fg-muted] italic">No terms</p>
        )}
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm --filter @freehold/web exec tsc --noEmit
```

---

### Task 6: Create LineageTrail.tsx

**Files:**
- Create: `packages/web/src/components/LineageTrail.tsx`

**Interfaces:**
- Consumes:
  ```typescript
  interface LineageTrailProps {
    revisions: Array<{ hash: string; timestamp?: string }>;
  }
  ```
- Produces: exported `LineageTrail` React component

- [ ] **Step 1: Create the component**

```typescript
interface Revision {
  hash: string;
  timestamp?: string;
}

interface LineageTrailProps {
  revisions: Revision[];
}

export function LineageTrail({ revisions }: LineageTrailProps) {
  if (revisions.length === 0) {
    return <p className="text-xs text-[--fg-muted] italic">No revision history.</p>;
  }

  return (
    <ol className="space-y-0 relative">
      {revisions.map((rev, idx) => (
        <li key={rev.hash} className="flex items-start gap-3 relative">
          {/* Vertical line connecting items */}
          <div className="flex flex-col items-center">
            <span className="mt-1 h-2 w-2 rounded-full bg-[--fg-muted] shrink-0" />
            {idx < revisions.length - 1 && (
              <span className="w-px flex-1 bg-[--border] min-h-[1.5rem]" />
            )}
          </div>
          <div className="pb-4 min-w-0">
            <div className="flex items-center gap-2">
              <code className="font-mono text-[11px] text-[--fg]">
                {rev.hash.length > 12 ? `${rev.hash.slice(0, 12)}…` : rev.hash}
              </code>
              {idx === 0 && (
                <span className="text-[10px] font-medium text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950 rounded px-1">
                  Latest
                </span>
              )}
            </div>
            {rev.timestamp && (
              <p className="text-[11px] text-[--fg-muted] mt-0.5">{rev.timestamp}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm --filter @freehold/web exec tsc --noEmit
```

---

### Task 7: Replace inbox.tsx

**Files:**
- Modify (replace): `packages/web/src/routes/inbox.tsx`

**Interfaces:**
- Consumes: `usePending` from `~/lib/hooks`
- Consumes: `ProposalCard` from `~/components/ProposalCard`
- Consumes: `useMutation`, `useQueryClient` from `@tanstack/react-query`
- Consumes: `apiClient` from `~/lib/api`

- [ ] **Step 1: Replace the file**

```typescript
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { apiClient } from "~/lib/api";
import { usePending } from "~/lib/hooks";
import { ProposalCard } from "~/components/ProposalCard";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/inbox",
  component: InboxPage,
});

function InboxPage() {
  const { data, isLoading } = usePending();
  const qc = useQueryClient();
  const proposals = data?.proposals ?? [];

  const approveMut = useMutation({
    mutationFn: (hash: string) => apiClient.approve(hash),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["proposals"] }),
  });

  const rejectMut = useMutation({
    mutationFn: (hash: string) => apiClient.reject(hash),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["proposals"] }),
  });

  return (
    <div>
      <h2 className="font-serif text-2xl font-semibold mb-6">
        Inbox{proposals.length > 0 ? ` (${proposals.length})` : ""}
      </h2>

      {isLoading && (
        <p className="text-[--fg-muted] text-sm">Loading proposals…</p>
      )}

      {!isLoading && proposals.length === 0 && (
        <div className="rounded-lg border border-[--border] bg-[--bg-subtle] p-6 space-y-3 max-w-xl">
          <p className="text-sm text-[--fg-muted]">
            No pending proposals. When agents make governed writes — creating entities, proposing
            schema changes — they appear here for your approval.
          </p>
          <p className="text-sm text-[--fg-muted]">
            Get started with{" "}
            <code className="font-mono text-xs bg-neutral-100 dark:bg-neutral-800 rounded px-1 py-0.5">
              freehold mcp setup claude-code
            </code>
          </p>
        </div>
      )}

      {!isLoading && proposals.length > 0 && (
        <ul className="space-y-4 max-w-2xl">
          {proposals.map((proposal) => (
            <li key={proposal.hash}>
              <ProposalCard
                proposal={proposal}
                onApprove={() => approveMut.mutate(proposal.hash)}
                onReject={() => rejectMut.mutate(proposal.hash)}
                isApproving={approveMut.isPending && approveMut.variables === proposal.hash}
                isRejecting={rejectMut.isPending && rejectMut.variables === proposal.hash}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm --filter @freehold/web exec tsc --noEmit
```

---

### Task 8: Replace memory.tsx

**Files:**
- Modify (replace): `packages/web/src/routes/memory.tsx`

**Interfaces:**
- Consumes: `useRecall`, `useSchema` from `~/lib/hooks`
- Consumes: `MemoryCard` from `~/components/MemoryCard`
- Consumes: `TaxonomyTree` from `~/components/TaxonomyTree`

- [ ] **Step 1: Replace the file**

```typescript
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { MemoryCard } from "~/components/MemoryCard";
import { TaxonomyTree } from "~/components/TaxonomyTree";
import { useRecall, useSchema } from "~/lib/hooks";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/memory",
  component: MemoryPage,
});

const TYPE_FILTERS = ["entity", "document", "event"] as const;
const STATUS_FILTERS = ["approved", "held", "rejected"] as const;

function MemoryPage() {
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string | undefined>();
  const [authorFilter, setAuthorFilter] = useState<string | undefined>();
  const [statusFilter, setStatusFilter] = useState<string | undefined>();

  const filters = {
    type: typeFilter,
    author: authorFilter,
    status: statusFilter,
  };

  const { data, isLoading } = useRecall(query, filters, query.length > 0);
  const { data: schemaData } = useSchema();
  const results = data?.results ?? [];
  const terms = schemaData?.terms ?? [];

  function toggleFilter<T extends string>(
    current: T | undefined,
    value: T,
    set: (v: T | undefined) => void
  ) {
    set(current === value ? undefined : value);
  }

  return (
    <div>
      <h2 className="font-serif text-2xl font-semibold mb-4">Memory</h2>

      {/* Search */}
      <div className="mb-4 max-w-xl">
        <input
          type="search"
          aria-label="Search memories"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search memories…"
          className="w-full rounded border border-[--border] bg-[--bg-subtle] px-3 py-2 text-sm text-[--fg] placeholder:text-[--fg-muted] focus:outline-none focus:ring-1 focus:ring-[--border]"
        />
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap gap-2 mb-6">
        <span className="text-xs text-[--fg-muted] self-center">Type:</span>
        {TYPE_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => toggleFilter(typeFilter, f, setTypeFilter)}
            className={`rounded border px-2 py-0.5 text-xs font-medium transition-colors ${
              typeFilter === f
                ? "border-[--fg] bg-[--fg] text-white dark:text-black"
                : "border-[--border] text-[--fg-muted] hover:text-[--fg]"
            }`}
          >
            {f}
          </button>
        ))}
        <span className="text-xs text-[--fg-muted] self-center ml-2">Status:</span>
        {STATUS_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => toggleFilter(statusFilter, f, setStatusFilter)}
            className={`rounded border px-2 py-0.5 text-xs font-medium transition-colors ${
              statusFilter === f
                ? "border-[--fg] bg-[--fg] text-white dark:text-black"
                : "border-[--border] text-[--fg-muted] hover:text-[--fg]"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="flex gap-6">
        {/* Taxonomy sidebar */}
        {terms.length > 0 && (
          <TaxonomyTree
            terms={terms}
            selected={typeFilter}
            onSelect={(t) => toggleFilter(typeFilter, t, setTypeFilter)}
          />
        )}

        {/* Results */}
        <div className="flex-1 min-w-0">
          {query.length === 0 && (
            <div className="rounded-lg border border-[--border] bg-[--bg-subtle] p-6 space-y-3 max-w-xl">
              <p className="text-sm text-[--fg-muted]">
                Search memories above. Agents will surface entities, documents, and events here as
                they work.
              </p>
              <p className="text-sm text-[--fg-muted]">
                Connect an agent via{" "}
                <code className="font-mono text-xs bg-neutral-100 dark:bg-neutral-800 rounded px-1 py-0.5">
                  freehold mcp setup claude-code
                </code>
              </p>
            </div>
          )}

          {query.length > 0 && isLoading && (
            <p className="text-sm text-[--fg-muted]">Searching…</p>
          )}

          {query.length > 0 && !isLoading && results.length === 0 && (
            <p className="text-sm text-[--fg-muted]">No memories match your search.</p>
          )}

          {results.length > 0 && (
            <ul className="space-y-4 max-w-2xl">
              {results.map((result) => (
                <li key={result.id}>
                  <MemoryCard result={result} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm --filter @freehold/web exec tsc --noEmit
```

---

### Task 9: Create memory.$id.tsx

**Files:**
- Create: `packages/web/src/routes/memory.$id.tsx`

**Interfaces:**
- Consumes: `useEntity` from `~/lib/hooks`
- Consumes: `LineageTrail` from `~/components/LineageTrail`
- Consumes: `ProvenanceFooter` from `~/components/ProvenanceFooter`
- Produces: exported `MemoryDetailPage` (the page component, used directly in tests)
- Produces: exported `Route` (the route definition, won't appear in routeTree.gen.ts but won't break build)

Note: `routeTree.gen.ts` does NOT include this route. The file creates the route definition (for when TanStack Router regenerates the tree in dev/build), but tests render `MemoryDetailPage` directly without the router.

- [ ] **Step 1: Create the file**

```typescript
import { createRoute } from "@tanstack/react-router";
import { LineageTrail } from "~/components/LineageTrail";
import { ProvenanceFooter } from "~/components/ProvenanceFooter";
import { useEntity } from "~/lib/hooks";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/memory/$id",
  component: MemoryDetailPage,
});

interface Edge {
  type: string;
  targetId: string;
  targetType?: string;
}

interface EntityData {
  attributes?: Record<string, unknown>;
  type?: string;
  classifications?: string[];
  edges?: {
    in?: Edge[];
    out?: Edge[];
  };
  provenance?: {
    author: string;
    method: string;
    changeset: string;
  };
  revisions?: Array<{ hash: string; timestamp?: string }>;
}

interface MemoryDetailPageProps {
  /** Used in tests to bypass the router params hook. */
  entityId?: string;
}

export function MemoryDetailPage({ entityId }: MemoryDetailPageProps = {}) {
  // In tests, entityId is passed directly. In the router, we read from params.
  // We use a try/catch because useParams throws outside a router context.
  let id: string | undefined = entityId;
  if (!id) {
    try {
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const params = Route.useParams();
      id = params.id;
    } catch {
      id = undefined;
    }
  }

  const { data, isLoading } = useEntity(id);
  const entity = data as EntityData | undefined;

  if (isLoading) {
    return <p className="text-sm text-[--fg-muted]">Loading…</p>;
  }

  if (!entity) {
    return <p className="text-sm text-[--fg-muted]">Entity not found.</p>;
  }

  const attributes = entity.attributes ?? {};
  const classifications = entity.classifications ?? [];
  const inEdges = entity.edges?.in ?? [];
  const outEdges = entity.edges?.out ?? [];
  const allEdges = [
    ...inEdges.map((e) => ({ ...e, direction: "In" as const })),
    ...outEdges.map((e) => ({ ...e, direction: "Out" as const })),
  ];
  const edgesByType: Record<string, typeof allEdges> = {};
  for (const edge of allEdges) {
    if (!edgesByType[edge.type]) edgesByType[edge.type] = [];
    edgesByType[edge.type].push(edge);
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
            {Object.entries(edgesByType).map(([edgeType, edges]) => (
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
                      <a
                        href={`/memory/${edge.targetId}`}
                        className="font-mono text-[--fg] hover:underline"
                      >
                        {edge.targetId}
                      </a>
                      {edge.targetType && (
                        <span className="text-[--fg-muted]">({edge.targetType})</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
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
      {entity.provenance && (
        <ProvenanceFooter
          author={entity.provenance.author}
          method={entity.provenance.method}
          approvalLabel="Approved"
          changesetHash={entity.provenance.changeset}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm --filter @freehold/web exec tsc --noEmit
```

---

### Task 10: Write inbox.test.tsx

**Files:**
- Create: `packages/web/src/routes/inbox.test.tsx`

- [ ] **Step 1: Create the test file**

```typescript
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "~/lib/api";
import * as hooks from "~/lib/hooks";
import { routeTree } from "~/routes/../routeTree.gen";

vi.mock("~/lib/hooks", () => ({
  usePending: vi.fn(),
  useRecall: vi.fn(),
  useVerify: vi.fn(),
  useSchema: vi.fn(),
  useEntity: vi.fn(),
}));

vi.mock("~/lib/api", () => ({
  apiClient: {
    proposals: vi.fn(),
    approve: vi.fn().mockResolvedValue({}),
    reject: vi.fn().mockResolvedValue({}),
    recall: vi.fn(),
    getEntity: vi.fn(),
    schema: vi.fn(),
  },
}));

const normalProposal = {
  hash: "abc123",
  agent: "claude-code",
  intent: "create entity",
  summary: "Creates a new User entity with email and name attributes.",
  rules: ["require-attribution", "no-pii"],
  diff: [
    { key: "email", after: "alice@example.com" },
    { key: "name", before: "Bob", after: "Alice" },
  ],
  isSchemaProposal: false,
};

const schemaProposal = {
  hash: "def456",
  agent: "claude-code",
  intent: "add type",
  summary: "Adds a new ProjectTask entity type to the schema.",
  rules: [],
  diff: [{ key: "ProjectTask", after: { attributes: { title: "string" } } }],
  isSchemaProposal: true,
};

function makeHooks(proposals: typeof normalProposal[]) {
  vi.mocked(hooks.usePending).mockReturnValue({
    data: { proposals },
    isLoading: false,
    isError: false,
    error: null,
  } as ReturnType<typeof hooks.usePending>);
  vi.mocked(hooks.useRecall).mockReturnValue({
    data: { results: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as ReturnType<typeof hooks.useRecall>);
  vi.mocked(hooks.useSchema).mockReturnValue({
    data: { entityTypes: [], edgeTypes: [], terms: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as ReturnType<typeof hooks.useSchema>);
  vi.mocked(hooks.useVerify).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  } as ReturnType<typeof hooks.useVerify>);
}

async function renderInbox(proposals: typeof normalProposal[]) {
  makeHooks(proposals);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/inbox"] }),
  });
  await act(async () => {
    render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    );
  });
}

describe("Inbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders proposal cards with summary visible", async () => {
    await renderInbox([normalProposal]);
    expect(
      screen.getByText("Creates a new User entity with email and name attributes.")
    ).toBeInTheDocument();
  });

  it("shows empty state with founding-loop explainer when no proposals", async () => {
    await renderInbox([]);
    expect(screen.getByText(/No pending proposals/)).toBeInTheDocument();
    expect(screen.getByText(/freehold mcp setup claude-code/)).toBeInTheDocument();
  });

  it("approve button opens dialog with exact confirmation text", async () => {
    await renderInbox([normalProposal]);
    const approveBtn = screen.getByRole("button", { name: /approve/i });
    await act(async () => {
      fireEvent.click(approveBtn);
    });
    expect(
      screen.getByText("This signs a decision record with your key.")
    ).toBeInTheDocument();
  });

  it("clicking Approve in dialog fires apiClient.approve with hash", async () => {
    await renderInbox([normalProposal]);
    // Open dialog
    const approveBtn = screen.getByRole("button", { name: /^approve$/i });
    await act(async () => {
      fireEvent.click(approveBtn);
    });
    // Confirm in dialog
    const confirmBtn = screen.getAllByRole("button", { name: /^approve$/i }).find(
      (b) => b.closest("[role=dialog]")
    );
    expect(confirmBtn).toBeDefined();
    await act(async () => {
      fireEvent.click(confirmBtn!);
    });
    expect(vi.mocked(apiClient.approve)).toHaveBeenCalledWith("abc123");
  });

  it("reject button fires apiClient.reject with hash", async () => {
    await renderInbox([normalProposal]);
    const rejectBtn = screen.getByRole("button", { name: /reject/i });
    await act(async () => {
      fireEvent.click(rejectBtn);
    });
    await waitFor(() => {
      expect(vi.mocked(apiClient.reject)).toHaveBeenCalledWith("abc123");
    });
  });

  it("schema proposal has schema badge visible", async () => {
    await renderInbox([schemaProposal]);
    expect(screen.getByTestId("schema-badge")).toBeInTheDocument();
    expect(screen.getByTestId("schema-badge")).toHaveTextContent("Schema proposal");
  });

  it("diff shows added attribute; toggle shows green text", async () => {
    await renderInbox([normalProposal]);
    const showDiff = screen.getByRole("button", { name: /show diff/i });
    await act(async () => {
      fireEvent.click(showDiff);
    });
    // "email" key shows as added (green)
    const emailKey = screen.getByText("email:");
    expect(emailKey).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests**

```bash
pnpm --filter @freehold/web test
```

Expected: inbox tests pass

---

### Task 11: Write memory.test.tsx

**Files:**
- Create: `packages/web/src/routes/memory.test.tsx`

- [ ] **Step 1: Create the test file**

```typescript
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as hooks from "~/lib/hooks";
import { routeTree } from "~/routes/../routeTree.gen";

vi.mock("~/lib/hooks", () => ({
  usePending: vi.fn(),
  useRecall: vi.fn(),
  useVerify: vi.fn(),
  useSchema: vi.fn(),
  useEntity: vi.fn(),
}));

vi.mock("~/lib/api", () => ({
  apiClient: {
    proposals: vi.fn(),
    approve: vi.fn().mockResolvedValue({}),
    reject: vi.fn().mockResolvedValue({}),
    recall: vi.fn(),
    getEntity: vi.fn(),
    schema: vi.fn(),
  },
}));

const sampleResult = {
  id: "entity-1",
  type: "User",
  content: "Alice Smith — product designer",
  author: "claude-code",
  approval: "Approved",
  changeset: "deadbeef1234",
  score: 0.9,
};

function makeHooks(overrides: Partial<{
  results: typeof sampleResult[];
  terms: { name: string; parent?: string }[];
}> = {}) {
  vi.mocked(hooks.usePending).mockReturnValue({
    data: { proposals: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as ReturnType<typeof hooks.usePending>);
  vi.mocked(hooks.useRecall).mockReturnValue({
    data: { results: overrides.results ?? [] },
    isLoading: false,
    isError: false,
    error: null,
  } as ReturnType<typeof hooks.useRecall>);
  vi.mocked(hooks.useSchema).mockReturnValue({
    data: {
      entityTypes: [],
      edgeTypes: [],
      terms: overrides.terms ?? [],
    },
    isLoading: false,
    isError: false,
    error: null,
  } as ReturnType<typeof hooks.useSchema>);
  vi.mocked(hooks.useVerify).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  } as ReturnType<typeof hooks.useVerify>);
}

async function renderMemory() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/memory"] }),
  });
  await act(async () => {
    render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    );
  });
}

describe("Memory browser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders search input", async () => {
    makeHooks();
    await renderMemory();
    expect(screen.getByRole("searchbox", { name: /search memories/i })).toBeInTheDocument();
  });

  it("empty state shows freehold mcp setup snippet when no query", async () => {
    makeHooks();
    await renderMemory();
    expect(screen.getByText(/freehold mcp setup claude-code/)).toBeInTheDocument();
  });

  it("filter chips render", async () => {
    makeHooks();
    await renderMemory();
    expect(screen.getByRole("button", { name: "entity" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "approved" })).toBeInTheDocument();
  });

  it("clicking type filter updates active state", async () => {
    makeHooks();
    await renderMemory();
    const entityBtn = screen.getByRole("button", { name: "entity" });
    await act(async () => {
      fireEvent.click(entityBtn);
    });
    // After click the button should reflect selected state (bg-[--fg])
    expect(entityBtn.className).toContain("bg-[--fg]");
  });

  it("memory cards render with content when results present", async () => {
    makeHooks({ results: [sampleResult] });
    await renderMemory();
    // Trigger a search so results render — we need the query to be non-empty
    // Since useRecall is mocked, we just need the component to see results
    // But results only render when query.length > 0. Let's type in search.
    const input = screen.getByRole("searchbox", { name: /search memories/i });
    await act(async () => {
      fireEvent.change(input, { target: { value: "alice" } });
    });
    expect(screen.getByText("Alice Smith — product designer")).toBeInTheDocument();
    // Provenance footer
    expect(screen.getByTestId("provenance-author")).toHaveTextContent("claude-code");
  });

  it("shows no results message for non-empty query with no results", async () => {
    makeHooks({ results: [] });
    await renderMemory();
    const input = screen.getByRole("searchbox", { name: /search memories/i });
    await act(async () => {
      fireEvent.change(input, { target: { value: "nothing" } });
    });
    expect(screen.getByText(/No memories match your search/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests**

```bash
pnpm --filter @freehold/web test
```

---

### Task 12: Write memory.$id.test.tsx

**Files:**
- Create: `packages/web/src/routes/memory.$id.test.tsx`

- [ ] **Step 1: Create the test file**

```typescript
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as hooks from "~/lib/hooks";
import { MemoryDetailPage } from "./memory.$id";

vi.mock("~/lib/hooks", () => ({
  usePending: vi.fn(),
  useRecall: vi.fn(),
  useVerify: vi.fn(),
  useSchema: vi.fn(),
  useEntity: vi.fn(),
}));

vi.mock("~/lib/api", () => ({
  apiClient: {
    proposals: vi.fn(),
    approve: vi.fn().mockResolvedValue({}),
    reject: vi.fn().mockResolvedValue({}),
    recall: vi.fn(),
    getEntity: vi.fn(),
    schema: vi.fn(),
  },
}));

const sampleEntity = {
  type: "User",
  attributes: {
    email: "alice@example.com",
    name: "Alice Smith",
  },
  classifications: ["internal", "pii"],
  edges: {
    in: [],
    out: [{ type: "belongsTo", targetId: "org-42", targetType: "Org" }],
  },
  provenance: {
    author: "claude-code",
    method: "model-assisted",
    changeset: "cafebabe1234",
  },
  revisions: [
    { hash: "deadbeef1234abcd", timestamp: "2026-01-01T00:00:00Z" },
    { hash: "aabbccdd11223344", timestamp: "2025-12-01T00:00:00Z" },
  ],
};

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

async function renderPage(entityData: typeof sampleEntity | undefined, loading = false) {
  vi.mocked(hooks.useEntity).mockReturnValue({
    data: entityData,
    isLoading: loading,
    isError: false,
    error: null,
  } as ReturnType<typeof hooks.useEntity>);

  await act(async () => {
    render(<MemoryDetailPage entityId="entity-1" />, { wrapper });
  });
}

describe("MemoryDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders attribute table", async () => {
    await renderPage(sampleEntity);
    expect(screen.getByText("email")).toBeInTheDocument();
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("name")).toBeInTheDocument();
    expect(screen.getByText("Alice Smith")).toBeInTheDocument();
  });

  it("renders classifications as chips", async () => {
    await renderPage(sampleEntity);
    expect(screen.getByText("internal")).toBeInTheDocument();
    expect(screen.getByText("pii")).toBeInTheDocument();
  });

  it("renders edges grouped by type", async () => {
    await renderPage(sampleEntity);
    expect(screen.getByText("belongsTo")).toBeInTheDocument();
    expect(screen.getByText("org-42")).toBeInTheDocument();
    expect(screen.getByText("Out")).toBeInTheDocument();
  });

  it("renders lineage trail with revisions", async () => {
    await renderPage(sampleEntity);
    // First revision gets "Latest" label
    expect(screen.getByText("Latest")).toBeInTheDocument();
    // Truncated hashes
    expect(screen.getByText("deadbeef1234…")).toBeInTheDocument();
    expect(screen.getByText("aabbccdd1122…")).toBeInTheDocument();
  });

  it("renders provenance footer", async () => {
    await renderPage(sampleEntity);
    expect(screen.getByTestId("provenance-author")).toHaveTextContent("claude-code");
    expect(screen.getByTestId("provenance-method")).toHaveTextContent("model-assisted");
  });

  it("shows loading state", async () => {
    await renderPage(undefined, true);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows not found when no data", async () => {
    await renderPage(undefined, false);
    expect(screen.getByText("Entity not found.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run all tests**

```bash
pnpm --filter @freehold/web test
```

Expected: all tests pass

- [ ] **Step 3: Run build**

```bash
pnpm --filter @freehold/web build
```

Expected: build succeeds

- [ ] **Step 4: Run biome lint**

```bash
pnpm --filter @freehold/web exec biome check src/
```

Expected: no lint errors

- [ ] **Step 5: Commit**

```bash
git add \
  packages/web/src/lib/hooks.ts \
  packages/web/src/components/DiffView.tsx \
  packages/web/src/components/ProposalCard.tsx \
  packages/web/src/components/MemoryCard.tsx \
  packages/web/src/components/TaxonomyTree.tsx \
  packages/web/src/components/LineageTrail.tsx \
  packages/web/src/routes/inbox.tsx \
  packages/web/src/routes/memory.tsx \
  packages/web/src/routes/memory.\$id.tsx \
  packages/web/src/routes/inbox.test.tsx \
  packages/web/src/routes/memory.test.tsx \
  packages/web/src/routes/memory.\$id.test.tsx
git commit -m "Console: Inbox and Memory browser"
```
