import { createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useChangeset } from "~/lib/changeset";
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
    return {
      chip: "Saves instantly",
      chipTone: "saves",
      sentence: "it saves with no further checks.",
    };
  }
  if ("reviewers" in req) {
    const r = req.reviewers as { quorum?: number; role?: string };
    const who = r.role === "owner" ? "you approve" : `a ${r.role} approves`;
    const quorum = r.quorum && r.quorum > 1 ? ` (${r.quorum} approvals)` : "";
    return {
      chip: "Goes to Inbox",
      chipTone: "review",
      sentence: `it lands in the Inbox and stays pending until ${who} it${quorum}.`,
    };
  }
  if ("attestation_required" in req) {
    const a = req.attestation_required as { attester_class?: string };
    return {
      chip: "Needs proof",
      chipTone: "attestation",
      sentence: `it must carry a signed envelope from the ${a.attester_class ?? "attester"} proving what produced it, or it stays pending.`,
    };
  }
  if ("schema_valid" in req) {
    return {
      chip: "Saves instantly",
      chipTone: "saves",
      sentence: "it saves on the spot — the only check is that it fits the schema.",
    };
  }
  return { chip: "Custom", chipTone: "review", sentence: JSON.stringify(req) };
}

/** Section framing per outcome group, in the order shown on the page. */
export const OUTCOME_SECTIONS: Array<{
  tone: RequirementView["chipTone"];
  title: string;
  blurb: string;
}> = [
  {
    tone: "saves",
    title: "Saves without you",
    blurb:
      "Writes matching these rules save on their own — you never see them unless you go looking.",
  },
  {
    tone: "review",
    title: "Waits in your Inbox",
    blurb: "Writes matching these rules stay pending until you approve or reject them.",
  },
  {
    tone: "attestation",
    title: "Needs cryptographic proof",
    blurb:
      "Writes matching these rules must arrive with a signed envelope naming what produced them.",
  },
];

const CHIP_STYLES: Record<RequirementView["chipTone"], string> = {
  saves:
    "bg-[var(--color-status-approved-bg)] text-[var(--color-status-approved)] border-[var(--color-status-approved)]",
  review:
    "bg-[var(--color-status-pending-bg)] text-[var(--color-status-pending)] border-[var(--color-status-pending)]",
  attestation: "bg-(--bg-subtle) text-(--fg) border-(--border)",
};

// ---------------------------------------------------------------------------
// Structured rule editor — stages into changeset tray
// ---------------------------------------------------------------------------

interface PolicyRuleEditorProps {
  rule: PolicyRule;
  definition: PolicyDefinition;
  isStaged: boolean;
}

/** Requirement type for the structured editor dropdown. */
type RequireKind = "saves" | "review" | "attestation";

function requireKindFromRule(rule: PolicyRule): RequireKind {
  if (!rule.require) return "saves";
  if ("reviewers" in rule.require) return "review";
  if ("attestation_required" in rule.require) return "attestation";
  return "saves";
}

function buildRequireFromKind(
  kind: RequireKind,
  quorum: number,
  role: string,
  attesterClass: string
): Record<string, unknown> | undefined {
  if (kind === "saves") return undefined;
  if (kind === "review") {
    return { reviewers: { quorum, role } };
  }
  return { attestation_required: { attester_class: attesterClass } };
}

/** Derive path pattern chips from a selector (region values). */
function pathsFromSelector(sel: Selector | undefined): string[] {
  if (!sel) return [];
  const paths: string[] = [];
  function walk(s: Selector) {
    for (const [key, val] of Object.entries(s)) {
      if (key === "region" && typeof val === "string") paths.push(val);
      else if ((key === "all" || key === "any") && Array.isArray(val)) {
        for (const sub of val as Selector[]) walk(sub);
      } else if (key === "not" && val && typeof val === "object") {
        walk(val as Selector);
      }
    }
  }
  walk(sel);
  return paths;
}

function PolicyRuleEditor({ rule, definition, isStaged }: PolicyRuleEditorProps) {
  const { stage } = useChangeset();
  const [editing, setEditing] = useState(false);
  const [showDefinition, setShowDefinition] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Editable draft state
  const [draftName, setDraftName] = useState(rule.name);
  const [requireKind, setRequireKind] = useState<RequireKind>(() => requireKindFromRule(rule));
  const [quorum, setQuorum] = useState<number>(
    (rule.require as { reviewers?: { quorum?: number } } | undefined)?.reviewers?.quorum ?? 1
  );
  const [role, setRole] = useState<string>(
    (rule.require as { reviewers?: { role?: string } } | undefined)?.reviewers?.role ?? "owner"
  );
  const [attesterClass, setAttesterClass] = useState<string>(
    (rule.require as { attestation_required?: { attester_class?: string } } | undefined)
      ?.attestation_required?.attester_class ?? "indexer"
  );
  const [paths, setPaths] = useState<string[]>(() => pathsFromSelector(rule.select));
  const [newPath, setNewPath] = useState("");

  const req = describeRequirement(rule.require);
  const when = rule.select ? describeSelector(rule.select) : "every write";

  function startEditing() {
    setDraftName(rule.name);
    setRequireKind(requireKindFromRule(rule));
    const reviewers = (
      rule.require as { reviewers?: { quorum?: number; role?: string } } | undefined
    )?.reviewers;
    setQuorum(reviewers?.quorum ?? 1);
    setRole(reviewers?.role ?? "owner");
    setAttesterClass(
      (rule.require as { attestation_required?: { attester_class?: string } } | undefined)
        ?.attestation_required?.attester_class ?? "indexer"
    );
    setPaths(pathsFromSelector(rule.select));
    setNewPath("");
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
    setConfirmDelete(false);
  }

  function buildUpdatedRule(): PolicyRule {
    const updatedRequire = buildRequireFromKind(requireKind, quorum, role, attesterClass);
    // Rebuild selector from paths: if one path → { region: path }, multiple → { all: [{region}…] }
    let select: Selector | undefined;
    if (paths.length === 1) {
      select = { region: paths[0] };
    } else if (paths.length > 1) {
      select = { all: paths.map((p) => ({ region: p })) };
    }
    return {
      name: draftName,
      ...(select ? { select } : {}),
      ...(updatedRequire ? { require: updatedRequire } : {}),
    };
  }

  function handleStage() {
    const updatedRule = buildUpdatedRule();
    const nextDefinition: PolicyDefinition = {
      ...definition,
      rules: (definition.rules ?? []).map((r) => (r.name === rule.name ? updatedRule : r)),
    };
    stage({
      kind: "policy",
      label: `policy: edit rule ${rule.name}`,
      payload: nextDefinition,
    });
    setEditing(false);
  }

  function handleDeleteConfirm() {
    const nextDefinition: PolicyDefinition = {
      ...definition,
      rules: (definition.rules ?? []).filter((r) => r.name !== rule.name),
    };
    stage({
      kind: "policy",
      label: `policy: delete rule ${rule.name}`,
      payload: nextDefinition,
    });
    setConfirmDelete(false);
  }

  function addPath() {
    const trimmed = newPath.trim();
    if (trimmed && !paths.includes(trimmed)) {
      setPaths((p) => [...p, trimmed]);
    }
    setNewPath("");
  }

  function removePath(p: string) {
    setPaths((prev) => prev.filter((x) => x !== p));
  }

  return (
    <article
      className="border border-(--border) bg-(--bg) p-4 space-y-2.5"
      data-testid={`rule-${rule.name}`}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-mono text-[12px] text-(--fg) truncate">{rule.name}</h3>
        <div className="flex items-center gap-2 shrink-0">
          {isStaged && (
            <span className="inline-flex items-center border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide border-(--border) bg-(--bg-subtle) text-(--fg-muted)">
              staged
            </span>
          )}
          <span
            className={`inline-flex items-center border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${CHIP_STYLES[req.chipTone]}`}
          >
            {req.chip}
          </span>
        </div>
      </div>

      {!editing && (
        <p className="text-sm text-(--fg) leading-relaxed">
          When {when}, {req.sentence}
        </p>
      )}

      {/* Structured editor */}
      {editing ? (
        <div className="space-y-3">
          {/* Name */}
          <div className="space-y-1">
            <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted)">
              Rule name
            </span>
            <input
              type="text"
              aria-label="Rule name"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              className="w-full border border-(--border) bg-(--bg-subtle) px-2.5 py-1.5 font-mono text-[11px] text-(--fg) focus:outline-none focus:ring-1 focus:ring-(--border)"
            />
          </div>

          {/* Path patterns */}
          <div className="space-y-1">
            <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted)">
              Path patterns (regions)
            </span>
            <div className="flex flex-wrap gap-1.5">
              {paths.map((p) => (
                <span
                  key={p}
                  className="inline-flex items-center gap-1 border border-(--border) bg-(--bg-subtle) px-2 py-0.5 font-mono text-[10px] text-(--fg)"
                >
                  {p}
                  <button
                    type="button"
                    onClick={() => removePath(p)}
                    aria-label={`Remove path ${p}`}
                    className="text-(--fg-muted) hover:text-(--fg)"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-1.5">
              <input
                type="text"
                placeholder="workspace/scratch"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addPath()}
                className="flex-1 border border-(--border) bg-(--bg-subtle) px-2.5 py-1 font-mono text-[10px] text-(--fg) placeholder:text-(--fg-muted) focus:outline-none focus:ring-1 focus:ring-(--border)"
              />
              <button
                type="button"
                onClick={addPath}
                className="border border-(--border) px-2 py-1 font-mono text-[10px] text-(--fg-muted) hover:text-(--fg)"
              >
                Add
              </button>
            </div>
          </div>

          {/* Requirement type */}
          <div className="space-y-1">
            <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted)">
              Requirement
            </span>
            <select
              aria-label="Requirement"
              value={requireKind}
              onChange={(e) => setRequireKind(e.target.value as RequireKind)}
              className="border border-(--border) bg-(--bg-subtle) px-2.5 py-1 font-mono text-[10px] text-(--fg) focus:outline-none focus:ring-1 focus:ring-(--border)"
            >
              <option value="saves">Saves instantly (schema_valid)</option>
              <option value="review">Goes to Inbox (reviewers)</option>
              <option value="attestation">Needs proof (attestation_required)</option>
            </select>
          </div>

          {/* Reviewer details */}
          {requireKind === "review" && (
            <div className="flex items-center gap-3">
              <div className="space-y-0.5">
                <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted)">
                  Role
                </span>
                <input
                  type="text"
                  aria-label="Role"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className="border border-(--border) bg-(--bg-subtle) px-2 py-1 font-mono text-[10px] text-(--fg) w-24 focus:outline-none focus:ring-1 focus:ring-(--border)"
                />
              </div>
              <div className="space-y-0.5">
                <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted)">
                  Quorum
                </span>
                <input
                  type="number"
                  aria-label="Quorum"
                  min={1}
                  value={quorum}
                  onChange={(e) => setQuorum(Number(e.target.value))}
                  className="border border-(--border) bg-(--bg-subtle) px-2 py-1 font-mono text-[10px] text-(--fg) w-16 focus:outline-none focus:ring-1 focus:ring-(--border)"
                />
              </div>
            </div>
          )}

          {/* Attestation details */}
          {requireKind === "attestation" && (
            <div className="space-y-0.5">
              <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted)">
                Attester class
              </span>
              <input
                type="text"
                aria-label="Attester class"
                value={attesterClass}
                onChange={(e) => setAttesterClass(e.target.value)}
                className="border border-(--border) bg-(--bg-subtle) px-2 py-1 font-mono text-[10px] text-(--fg) w-40 focus:outline-none focus:ring-1 focus:ring-(--border)"
              />
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={handleStage}
              data-testid={`stage-rule-${rule.name}`}
              disabled={!draftName.trim()}
              className="border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-accent-fg)] disabled:opacity-50"
            >
              Stage change
            </button>
            <button
              type="button"
              onClick={cancelEditing}
              className="border border-(--border) px-3 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted) hover:text-(--fg)"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3 flex-wrap">
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
          {!confirmDelete ? (
            <button
              type="button"
              data-testid={`delete-rule-${rule.name}`}
              onClick={() => setConfirmDelete(true)}
              className="text-[11px] text-[var(--color-status-rejected)] underline underline-offset-2 hover:opacity-75"
            >
              Delete
            </button>
          ) : (
            <span className="flex items-center gap-2">
              <span className="text-[11px] text-(--fg-muted)">Remove this rule?</span>
              <button
                type="button"
                data-testid={`confirm-delete-${rule.name}`}
                onClick={handleDeleteConfirm}
                className="text-[11px] text-[var(--color-status-rejected)] underline underline-offset-2"
              >
                Yes, delete
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="text-[11px] text-(--fg-muted) underline underline-offset-2"
              >
                Keep
              </button>
            </span>
          )}
        </div>
      )}

      {/* Raw JSON toggle (read-only) */}
      {showDefinition && !editing && (
        <pre className="border border-(--border) bg-(--bg-subtle) p-2.5 font-mono text-[11px] text-(--fg) overflow-x-auto">
          {JSON.stringify(rule, null, 2)}
        </pre>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Add rule card — stages a new rule appended to the definition
// ---------------------------------------------------------------------------

function AddRuleCard({ definition }: { definition: PolicyDefinition }) {
  const { stage } = useChangeset();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [requireKind, setRequireKind] = useState<RequireKind>("saves");
  const [role, setRole] = useState("owner");
  const [quorum, setQuorum] = useState(1);
  const [attesterClass, setAttesterClass] = useState("indexer");

  function handleStage() {
    const newRequire = buildRequireFromKind(requireKind, quorum, role, attesterClass);
    const newRule: PolicyRule = {
      name,
      ...(newRequire ? { require: newRequire } : {}),
    };
    const nextDefinition: PolicyDefinition = {
      ...definition,
      rules: [...(definition.rules ?? []), newRule],
    };
    stage({
      kind: "policy",
      label: `policy: add rule ${name}`,
      payload: nextDefinition,
    });
    setOpen(false);
    setName("");
  }

  if (!open) {
    return (
      <button
        type="button"
        data-testid="add-rule-btn"
        onClick={() => setOpen(true)}
        className="border border-dashed border-(--border) px-4 py-2 text-xs text-(--fg-muted) hover:text-(--fg) w-full text-left"
      >
        + Add rule
      </button>
    );
  }

  return (
    <div className="border border-(--border) bg-(--bg) p-4 space-y-3" data-testid="add-rule-form">
      <div className="space-y-1">
        <label className="block font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted)">
          Rule name
        </label>
        <input
          type="text"
          aria-label="New rule name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full border border-(--border) bg-(--bg-subtle) px-2.5 py-1.5 font-mono text-[11px] text-(--fg) focus:outline-none focus:ring-1 focus:ring-(--border)"
        />
      </div>
      <div className="space-y-1">
        <label className="block font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted)">
          Requirement
        </label>
        <select
          value={requireKind}
          onChange={(e) => setRequireKind(e.target.value as RequireKind)}
          className="border border-(--border) bg-(--bg-subtle) px-2.5 py-1 font-mono text-[10px] text-(--fg) focus:outline-none"
        >
          <option value="saves">Saves instantly</option>
          <option value="review">Goes to Inbox</option>
          <option value="attestation">Needs proof</option>
        </select>
      </div>
      {requireKind === "review" && (
        <div className="flex gap-3">
          <div className="space-y-0.5">
            <label className="block font-mono text-[10px] uppercase text-(--fg-muted)">Role</label>
            <input
              type="text"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="border border-(--border) bg-(--bg-subtle) px-2 py-1 font-mono text-[10px] text-(--fg) w-24"
            />
          </div>
          <div className="space-y-0.5">
            <label className="block font-mono text-[10px] uppercase text-(--fg-muted)">Quorum</label>
            <input
              type="number"
              min={1}
              value={quorum}
              onChange={(e) => setQuorum(Number(e.target.value))}
              className="border border-(--border) bg-(--bg-subtle) px-2 py-1 font-mono text-[10px] text-(--fg) w-16"
            />
          </div>
        </div>
      )}
      {requireKind === "attestation" && (
        <div className="space-y-0.5">
          <label className="block font-mono text-[10px] uppercase text-(--fg-muted)">Attester class</label>
          <input
            type="text"
            value={attesterClass}
            onChange={(e) => setAttesterClass(e.target.value)}
            className="border border-(--border) bg-(--bg-subtle) px-2 py-1 font-mono text-[10px] text-(--fg) w-40"
          />
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="stage-add-rule-btn"
          disabled={!name.trim()}
          onClick={handleStage}
          className="border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-accent-fg)] disabled:opacity-50"
        >
          Stage add
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="border border-(--border) px-3 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted)"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function PolicyPage() {
  const { data, isLoading } = usePolicy();
  const { entries } = useChangeset();
  const definition = parseDefinition(data);
  const rules = definition?.rules ?? [];
  const policyName = (data as { name?: string } | undefined)?.name ?? definition?.policy ?? "";

  function isRuleStaged(ruleName: string): boolean {
    return entries.some((e) => e.kind === "policy" && e.label.includes(`rule ${ruleName}`));
  }

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
              Every write is checked against every rule. Each match adds a requirement, and the
              write saves once all of them are met. The groups below show where each rule sends a
              matching write.
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
            Edits stage into the changeset tray and take effect after you commit and approve the
            proposal in the Inbox.
          </p>

          {OUTCOME_SECTIONS.map((section) => {
            const sectionRules = rules.filter(
              (r) => describeRequirement(r.require).chipTone === section.tone
            );
            if (sectionRules.length === 0) return null;
            return (
              <section key={section.tone} data-testid={`outcome-${section.tone}`}>
                <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg) mb-0.5">
                  {section.title} <span className="text-(--fg-muted)">· {sectionRules.length}</span>
                </h3>
                <p className="text-xs text-(--fg-muted) mb-2">{section.blurb}</p>
                <ul className="space-y-3">
                  {sectionRules.map((rule) => (
                    <li key={rule.name}>
                      <PolicyRuleEditor
                        rule={rule}
                        definition={definition ?? {}}
                        isStaged={isRuleStaged(rule.name)}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}

          <AddRuleCard definition={definition ?? {}} />

          {/* The catch-all: what happens when nothing matches */}
          {definition?.default_posture && (
            <section data-testid="outcome-default">
              <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg) mb-0.5">
                Everything else
              </h3>
              <div className="border border-dashed border-(--border) bg-(--bg-subtle) p-4">
                <p className="text-sm text-(--fg) leading-relaxed">
                  {definition.default_posture === "restricted" ? (
                    <>
                      A write that matches none of the rules above goes to your Inbox and waits —
                      the default posture is{" "}
                      <span className="font-mono text-[12px]">restricted</span>.
                    </>
                  ) : (
                    <>
                      A write that matches none of the rules above follows the default posture:{" "}
                      <span className="font-mono text-[12px]">{definition.default_posture}</span>.
                    </>
                  )}
                </p>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
