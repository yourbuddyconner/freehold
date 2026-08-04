import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useState } from "react";
import { type PolicyRule, RuleCard } from "~/components/RuleCard";
import { apiClient } from "~/lib/api";
import { cn } from "~/lib/cn";
import { usePolicy } from "~/lib/hooks";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/policy",
  component: PolicyPage,
});

// ---------------------------------------------------------------------------
// Parse raw policy response into typed rules
// ---------------------------------------------------------------------------

function parseRules(raw: unknown): PolicyRule[] {
  if (!raw || typeof raw !== "object") return [];

  // Handle { rules: [...] }
  const obj = raw as Record<string, unknown>;
  const list = Array.isArray(obj.rules) ? obj.rules : Array.isArray(raw) ? raw : [];

  return (list as unknown[]).map((item, i) => {
    if (typeof item !== "object" || item === null) {
      return { id: `rule-${i}`, title: String(item) };
    }
    const r = item as Record<string, unknown>;
    return {
      id: typeof r.id === "string" ? r.id : `rule-${i}`,
      title:
        typeof r.title === "string"
          ? r.title
          : typeof r.description === "string"
            ? r.description
            : typeof r.id === "string"
              ? r.id
              : `Rule ${i + 1}`,
      selector: typeof r.selector === "string" ? r.selector : undefined,
      require: typeof r.require === "string" ? r.require : undefined,
      raw: JSON.stringify(item, null, 2),
    };
  });
}

function rulesToYaml(rules: PolicyRule[]): string {
  return `rules:\n${rules
    .map((r) => {
      let out = `  - id: ${r.id}\n    title: ${r.title}`;
      if (r.selector) out += `\n    selector: ${r.selector}`;
      if (r.require) out += `\n    require: ${r.require}`;
      return out;
    })
    .join("\n")}`;
}

// ---------------------------------------------------------------------------
// Edit drawer
// ---------------------------------------------------------------------------

interface EditDrawerProps {
  open: boolean;
  onClose: () => void;
  rule: PolicyRule;
  allRules: PolicyRule[];
}

function EditDrawer({ open, onClose, rule, allRules }: EditDrawerProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();

  // Editable YAML for this single rule
  const initialYaml = rule.raw ?? rulesToYaml([rule]);
  const [yaml, setYaml] = useState(initialYaml);
  const [diffVisible, setDiffVisible] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const submitMutation = useMutation({
    mutationFn: () => {
      // Build the full policy YAML: replace this rule's entry in the list with the edited YAML,
      // then wrap the whole thing as a policy document.
      // The API requires { policy_yaml: string }.
      const otherRules = allRules.filter((r) => r.id !== rule.id);
      const otherYaml = otherRules.length > 0 ? `\n${rulesToYaml(otherRules)}` : "";
      const policyYaml = `rules:\n${yaml.replace(/^rules:\n/, "")}${otherYaml}`;
      return apiClient.proposePolicy({ policy_yaml: policyYaml });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["policy"] });
      qc.invalidateQueries({ queryKey: ["proposals"] });
      onClose();
      navigate({ to: "/inbox" });
    },
    onError: (err: unknown) => {
      setSubmitError(err instanceof Error ? err.message : "Submission failed");
    },
  });

  const changed = yaml !== initialYaml;

  if (!open) return null;

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30 z-40" />
        <Dialog.Content
          className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-lg bg-white dark:bg-neutral-900 border-l border-[--border] shadow-xl flex flex-col"
          aria-label="Edit policy rule"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-[--border]">
            <Dialog.Title className="text-base font-semibold text-[--fg]">
              Edit rule: {rule.title}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="text-[--fg-muted] hover:text-[--fg] transition-colors"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </Dialog.Close>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-auto p-6 space-y-4">
            <p className="text-xs text-[--fg-muted]">
              Edit the rule below. Saving creates a policy-change proposal that will appear in your
              Inbox — you approve your own change, keeping the audit trail intact.
            </p>

            <textarea
              value={yaml}
              onChange={(e) => setYaml(e.target.value)}
              rows={14}
              spellCheck={false}
              className="w-full border border-[--border] bg-white dark:bg-neutral-900 p-3 font-mono text-xs text-[--fg] resize-y focus:outline-none focus:ring-2 focus:ring-[--fg]/20"
              aria-label="Policy YAML"
            />

            {/* Diff preview toggle */}
            {changed && (
              <div>
                <button
                  type="button"
                  onClick={() => setDiffVisible((v) => !v)}
                  aria-expanded={diffVisible}
                  className="text-xs text-[--fg-muted] underline underline-offset-2 hover:text-[--fg] transition-colors"
                >
                  {diffVisible ? "Hide diff" : "Show diff preview"}
                </button>
                {diffVisible && (
                  <div className="mt-2 border border-[--border] bg-[--bg-subtle] p-3 font-mono text-[11px] space-y-1">
                    <div className="text-[--fg-muted] text-xs mb-1">Before → After</div>
                    <div className="line-through text-[--fg-muted] whitespace-pre-wrap">
                      {initialYaml}
                    </div>
                    <div className="text-green-700 dark:text-green-400 whitespace-pre-wrap">
                      {yaml}
                    </div>
                  </div>
                )}
              </div>
            )}

            {submitError && (
              <p className="text-xs text-red-600 dark:text-red-400" role="alert">
                {submitError}
              </p>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-[--border] flex justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                className="border border-[--border] px-4 py-1.5 text-xs font-medium text-[--fg-muted] hover:text-[--fg] hover:bg-[--bg-subtle] transition-colors"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={() => submitMutation.mutate()}
              disabled={!changed || submitMutation.isPending}
              className={cn(
                "px-4 py-1.5 text-xs font-medium text-white transition-colors",
                changed && !submitMutation.isPending
                  ? "bg-[--fg] hover:opacity-80"
                  : "bg-[--fg-muted] opacity-50 cursor-not-allowed"
              )}
              data-testid="submit-policy"
            >
              {submitMutation.isPending ? "Submitting…" : "Submit proposal"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function PolicyPage() {
  const { data, isLoading } = usePolicy();
  const rules = parseRules(data);
  const [editingRule, setEditingRule] = useState<PolicyRule | null>(null);

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
          POLICY RULES
        </span>
      </div>
      <h2 className="text-2xl font-semibold tracking-tight">Policy</h2>

      {isLoading && <p className="text-[--fg-muted] text-sm">Loading policy…</p>}

      {!isLoading && rules.length === 0 && (
        <div className="border border-[--border] bg-[--bg-subtle] p-6 space-y-3 max-w-xl">
          <p className="text-sm text-[--fg-muted]">
            No policy rules loaded. Rules govern which agent writes require your approval before
            they are admitted to your memory graph.
          </p>
        </div>
      )}

      {!isLoading && rules.length > 0 && (
        <>
          <p className="text-xs text-[--fg-muted] max-w-xl">
            Editing a rule proposes a full policy replacement (held for owner approval). Per-rule
            conditional application is not yet wired — all rules apply globally for v0.
          </p>
          <ul className="space-y-3 max-w-2xl">
            {rules.map((rule) => (
              <li key={rule.id}>
                <RuleCard rule={rule} onEdit={() => setEditingRule(rule)} />
              </li>
            ))}
          </ul>
        </>
      )}

      {editingRule && (
        <EditDrawer
          open={!!editingRule}
          onClose={() => setEditingRule(null)}
          rule={editingRule}
          allRules={rules}
        />
      )}
    </div>
  );
}
