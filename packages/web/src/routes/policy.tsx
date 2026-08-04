import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { apiClient } from "~/lib/api";
import { usePolicy } from "~/lib/hooks";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/policy",
  component: PolicyPage,
});

// ---------------------------------------------------------------------------
// Policy definition shapes (the daemon's `definition` JSON)
// ---------------------------------------------------------------------------

type Selector = Record<string, unknown>;

interface PolicyRule {
  name: string;
  select?: Selector;
  require?: Record<string, unknown>;
}

interface PolicyDefinition {
  policy?: string;
  version?: number;
  default_posture?: string;
  roles?: Record<string, string[]>;
  rules?: PolicyRule[];
}

export function parseDefinition(raw: unknown): PolicyDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.definition === "string") {
    try {
      return JSON.parse(obj.definition) as PolicyDefinition;
    } catch {
      // fall through to the rules array
    }
  }
  if (Array.isArray(obj.rules)) return { rules: obj.rules as PolicyRule[] };
  return null;
}

// ---------------------------------------------------------------------------
// Plain-language rendering of selectors and requirements
// ---------------------------------------------------------------------------

/** One selector clause as a phrase. Unknown keys fall back to key: value. */
export function describeSelector(sel: Selector): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(sel)) {
    switch (key) {
      case "all":
        parts.push((value as Selector[]).map((s) => describeSelector(s)).join(" and "));
        break;
      case "any":
        parts.push((value as Selector[]).map((s) => describeSelector(s)).join(" or "));
        break;
      case "not": {
        const inner = value as Selector;
        // Common case reads better as "outside the … region"
        if (typeof inner.region === "string") {
          parts.push(`it is outside the ${inner.region} region`);
        } else {
          parts.push(`not (${describeSelector(inner)})`);
        }
        break;
      }
      case "author_kind":
        parts.push(value === "agent" ? "an agent wrote it" : `a ${value} wrote it`);
        break;
      case "region":
        parts.push(`it is classified in the ${value} region`);
        break;
      case "type":
        parts.push(`it creates or changes a ${value}`);
        break;
      case "basis":
        parts.push(`it is derived ${value}`);
        break;
      case "operation": {
        const ops = Array.isArray(value) ? value : [value];
        parts.push(`the operation is ${ops.join(", ")}`);
        break;
      }
      default:
        parts.push(`${key} is ${JSON.stringify(value)}`);
    }
  }
  return parts.join(" and ");
}

export interface RequirementView {
  chip: string;
  chipTone: "saves" | "review" | "attestation";
  sentence: string;
}

/** The rule's requirement as an outcome chip + sentence. */
export function describeRequirement(req: Record<string, unknown> | undefined): RequirementView {
  if (!req) {
    return { chip: "Saves", chipTone: "saves", sentence: "it saves with no further checks." };
  }
  if ("reviewers" in req) {
    const r = req.reviewers as { quorum?: number; role?: string };
    const who = r.role === "owner" ? "your" : `a ${r.role}'s`;
    const quorum = r.quorum && r.quorum > 1 ? ` (${r.quorum} approvals)` : "";
    return {
      chip: "Your review",
      chipTone: "review",
      sentence: `it waits in the Inbox for ${who} approval${quorum}.`,
    };
  }
  if ("attestation_required" in req) {
    const a = req.attestation_required as { attester_class?: string };
    return {
      chip: "Signed envelope",
      chipTone: "attestation",
      sentence: `it must carry a signed envelope from the ${a.attester_class ?? "attester"} before it saves.`,
    };
  }
  if ("schema_valid" in req) {
    return {
      chip: "Saves",
      chipTone: "saves",
      sentence: "it saves immediately after passing schema validation.",
    };
  }
  return { chip: "Custom", chipTone: "review", sentence: JSON.stringify(req) };
}

const CHIP_STYLES: Record<RequirementView["chipTone"], string> = {
  saves:
    "bg-[var(--color-status-approved-bg)] text-[var(--color-status-approved)] border-[var(--color-status-approved)]",
  review:
    "bg-[var(--color-status-pending-bg)] text-[var(--color-status-pending)] border-[var(--color-status-pending)]",
  attestation: "bg-(--bg-subtle) text-(--fg) border-(--border)",
};

// ---------------------------------------------------------------------------
// Rule card with drill-down and inline editing
// ---------------------------------------------------------------------------

interface RuleCardProps {
  rule: PolicyRule;
  definition: PolicyDefinition;
  index: number;
}

function PolicyRuleCard({ rule, definition, index }: RuleCardProps) {
  const qc = useQueryClient();
  const [showDefinition, setShowDefinition] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [proposedHash, setProposedHash] = useState<string | null>(null);

  const req = describeRequirement(rule.require);
  const when = rule.select ? describeSelector(rule.select) : "every write";

  const submit = useMutation({
    mutationFn: () => {
      const edited = JSON.parse(draft) as PolicyRule;
      const nextDefinition: PolicyDefinition = {
        ...definition,
        rules: (definition.rules ?? []).map((r) => (r.name === rule.name ? edited : r)),
      };
      // YAML is a superset of JSON, so the definition serializes directly
      return apiClient.proposePolicy({
        policy_yaml: JSON.stringify(nextDefinition, null, 2),
      }) as Promise<{
        status?: string;
        hash?: string;
      }>;
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["policy"] });
      qc.invalidateQueries({ queryKey: ["proposals"] });
      setEditing(false);
      setProposedHash(result?.hash ?? "");
    },
    onError: (err: unknown) => {
      setSubmitError(err instanceof Error ? err.message : "Submission failed");
    },
  });

  function startEditing() {
    setDraft(JSON.stringify(rule, null, 2));
    setSubmitError(null);
    setEditing(true);
  }

  let draftValid = true;
  if (editing) {
    try {
      JSON.parse(draft);
    } catch {
      draftValid = false;
    }
  }

  return (
    <article
      className="border border-(--border) bg-(--bg) p-4 space-y-2.5"
      data-testid={`rule-${rule.name}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-baseline gap-2.5 min-w-0">
          <span className="font-mono text-[10px] text-(--fg-muted)">{index + 1}</span>
          <h3 className="font-mono text-[12px] text-(--fg) truncate">{rule.name}</h3>
        </div>
        <span
          className={`shrink-0 inline-flex items-center border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${CHIP_STYLES[req.chipTone]}`}
        >
          {req.chip}
        </span>
      </div>

      {!editing && (
        <p className="text-sm text-(--fg) leading-relaxed">
          When {when}, {req.sentence}
        </p>
      )}

      {editing ? (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(16, draft.split("\n").length + 1)}
            spellCheck={false}
            aria-label={`Edit rule ${rule.name}`}
            className="w-full border border-(--border) bg-(--bg-subtle) p-2.5 font-mono text-[11px] text-(--fg) resize-y focus:outline-none focus:ring-1 focus:ring-(--border)"
          />
          {!draftValid && <p className="text-xs text-(--fg-muted)">Not valid JSON yet.</p>}
          {submitError && (
            <p className="text-xs text-[var(--color-status-rejected)]" role="alert">
              {submitError}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => submit.mutate()}
              disabled={!draftValid || submit.isPending}
              data-testid={`save-rule-${rule.name}`}
              className="border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-accent-fg)] disabled:opacity-50"
            >
              {submit.isPending ? "Proposing…" : "Propose change"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="border border-(--border) px-3 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted) hover:text-(--fg)"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowDefinition((v) => !v)}
            aria-expanded={showDefinition}
            className="text-[11px] text-(--fg-muted) underline underline-offset-2 hover:text-(--fg)"
          >
            {showDefinition ? "Hide definition" : "Show definition"}
          </button>
          <button
            type="button"
            onClick={startEditing}
            data-testid={`edit-rule-${rule.name}`}
            className="text-[11px] text-(--fg-muted) underline underline-offset-2 hover:text-(--fg)"
          >
            Edit
          </button>
        </div>
      )}

      {showDefinition && !editing && (
        <pre className="border border-(--border) bg-(--bg-subtle) p-2.5 font-mono text-[11px] text-(--fg) overflow-x-auto">
          {JSON.stringify(rule, null, 2)}
        </pre>
      )}

      {proposedHash !== null && (
        <p className="border border-[var(--color-status-pending)] bg-(--bg-subtle) p-2 text-xs text-(--fg)">
          Policy change proposed — it is pending in the{" "}
          <Link to="/inbox" className="underline">
            Inbox
          </Link>
          . The active policy stays unchanged until you approve it.
        </p>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function PolicyPage() {
  const { data, isLoading } = usePolicy();
  const definition = parseDefinition(data);
  const rules = definition?.rules ?? [];
  const policyName = (data as { name?: string } | undefined)?.name ?? definition?.policy ?? "";

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
          POLICY
        </span>
      </div>
      <h2 className="text-2xl font-semibold tracking-tight">{policyName || "Policy"}</h2>

      {isLoading && <p className="text-(--fg-muted) text-sm">Loading policy…</p>}

      {!isLoading && rules.length === 0 && (
        <div className="border border-(--border) bg-(--bg-subtle) p-6 space-y-3 max-w-xl">
          <p className="text-sm text-(--fg-muted)">
            No policy rules loaded. Rules govern which agent writes require your approval before
            they are admitted to your memory graph.
          </p>
        </div>
      )}

      {!isLoading && rules.length > 0 && (
        <div className="max-w-2xl space-y-4">
          {/* How a write is decided */}
          <div
            className="border border-(--border) bg-(--bg-subtle) p-4 space-y-1.5"
            data-testid="policy-summary"
          >
            <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted)">
              How a write is decided
            </p>
            <p className="text-sm text-(--fg) leading-relaxed">
              Every write is checked against the rules below. Each rule that matches adds its
              requirement; the write saves once every requirement is met.
              {definition?.default_posture === "restricted" ? (
                <>
                  {" "}
                  A write that matches no rule falls to the default posture,{" "}
                  <span className="font-mono text-[12px]">restricted</span> — it waits for your
                  review.
                </>
              ) : definition?.default_posture ? (
                <>
                  {" "}
                  The default posture for unmatched writes is{" "}
                  <span className="font-mono text-[12px]">{definition.default_posture}</span>.
                </>
              ) : null}
            </p>
            {definition?.roles && Object.keys(definition.roles).length > 0 && (
              <p className="text-xs text-(--fg-muted)">
                Roles:{" "}
                {Object.entries(definition.roles)
                  .map(
                    ([role, principals]) =>
                      `${role} = ${principals.map((p) => p.replace("principal:", "")).join(", ")}`
                  )
                  .join(" · ")}
              </p>
            )}
          </div>

          <p className="text-xs text-(--fg-muted)">
            Editing a rule proposes a policy change; the new policy takes effect only after you
            approve it in the Inbox.
          </p>

          <ul className="space-y-3">
            {rules.map((rule, i) => (
              <li key={rule.name}>
                <PolicyRuleCard rule={rule} definition={definition ?? {}} index={i} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
