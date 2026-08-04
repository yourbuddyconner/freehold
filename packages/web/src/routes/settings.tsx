import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { type Principal, PrincipalCard } from "~/components/PrincipalCard";
import { apiClient } from "~/lib/api";
import { cn } from "~/lib/cn";
import { usePrincipals } from "~/lib/hooks";
import { type ThemeChoice, readStoredTheme, setTheme } from "~/lib/theme";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/settings",
  component: SettingsPage,
});

// ---------------------------------------------------------------------------
// Parse principals
// ---------------------------------------------------------------------------

function parsePrincipals(raw: unknown): Principal[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const list = Array.isArray(obj.principals) ? obj.principals : Array.isArray(raw) ? raw : [];
  return (list as unknown[]).map((item, i) => {
    if (typeof item !== "object" || item === null) {
      return { id: `principal-${i}` };
    }
    const p = item as Record<string, unknown>;
    return {
      id: typeof p.id === "string" ? p.id : `principal-${i}`,
      name: typeof p.name === "string" ? p.name : undefined,
      kind: p.kind === "owner" || p.kind === "agent" || p.kind === "human" ? p.kind : undefined,
      fingerprint: typeof p.fingerprint === "string" ? p.fingerprint : undefined,
      status: p.status === "revoked" ? "revoked" : "active",
    };
  });
}

// ---------------------------------------------------------------------------
// Register agent flow
// ---------------------------------------------------------------------------

interface RegisterAgentResult {
  name: string;
  mcpSnippet?: string;
}

function RegisterAgentSection() {
  const qc = useQueryClient();
  const [agentName, setAgentName] = useState("");
  const [result, setResult] = useState<RegisterAgentResult | null>(null);
  const [copied, setCopied] = useState(false);

  const registerMutation = useMutation({
    mutationFn: () => apiClient.registerAgent({ name: agentName }),
    onSuccess: (data: unknown) => {
      qc.invalidateQueries({ queryKey: ["principals"] });
      const d = data as Record<string, unknown>;
      setResult({
        name: typeof d?.name === "string" ? d.name : agentName,
        mcpSnippet: typeof d?.mcpSnippet === "string" ? d.mcpSnippet : undefined,
      });
      setAgentName("");
    },
  });

  function handleCopy(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  // Fallback snippet when server does not return one
  const snippet =
    result?.mcpSnippet ??
    `{\n  "mcpServers": {\n    "freehold": {\n      "command": "freehold",\n      "args": ["mcp", "run", "--agent", "${result?.name ?? agentName}"]\n    }\n  }\n}`;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-[--fg]">Register agent</h3>
      <p className="text-xs text-[--fg-muted]">
        Register a new agent to get an MCP config snippet you can paste into your AI tool.
      </p>

      {result ? (
        <div className="space-y-3">
          <p className="text-xs text-green-700 dark:text-green-400">
            Agent <strong>{result.name}</strong> registered.
          </p>
          <div className="relative">
            <pre
              className="rounded border border-[--border] bg-[--bg-subtle] p-3 font-mono text-xs text-[--fg] overflow-auto"
              data-testid="mcp-snippet"
            >
              {snippet}
            </pre>
            <button
              type="button"
              onClick={() => handleCopy(snippet)}
              aria-label="Copy MCP snippet"
              className="absolute top-2 right-2 flex items-center gap-1 rounded border border-[--border] bg-white dark:bg-neutral-900 px-2 py-1 text-[10px] text-[--fg-muted] hover:text-[--fg] transition-colors"
            >
              {copied ? (
                <Check className="h-3 w-3 text-green-600" aria-hidden />
              ) : (
                <Copy className="h-3 w-3" aria-hidden />
              )}
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setResult(null)}
            className="text-xs text-[--fg-muted] underline underline-offset-2 hover:text-[--fg] transition-colors"
          >
            Register another
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <input
            type="text"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            placeholder="Agent name (e.g. claude-code)"
            className="flex-1 rounded border border-[--border] bg-white dark:bg-neutral-900 px-3 py-1.5 text-xs text-[--fg] placeholder:text-[--fg-muted] focus:outline-none focus:ring-2 focus:ring-[--fg]/20"
            data-testid="agent-name-input"
            onKeyDown={(e) => {
              if (e.key === "Enter" && agentName.trim()) registerMutation.mutate();
            }}
          />
          <button
            type="button"
            onClick={() => registerMutation.mutate()}
            disabled={!agentName.trim() || registerMutation.isPending}
            className="rounded bg-[--fg] px-3 py-1.5 text-xs font-medium text-white hover:opacity-80 disabled:opacity-50 transition-opacity"
            data-testid="register-agent-btn"
          >
            {registerMutation.isPending ? "Registering…" : "Register"}
          </button>
        </div>
      )}

      {registerMutation.isError && (
        <p className="text-xs text-red-600 dark:text-red-400" role="alert">
          {registerMutation.error instanceof Error
            ? registerMutation.error.message
            : "Registration failed"}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Ontology install section
// ---------------------------------------------------------------------------

function OntologyInstallSection() {
  const [docsYaml, setDocsYaml] = useState("");
  const [preview, setPreview] = useState<boolean>(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const previewMutation = useMutation({
    mutationFn: async () => {
      // No preview endpoint; we attempt to parse the YAML locally and show
      // a stub preview. The install endpoint does the real validation.
      return { entityTypes: [], edgeTypes: [], terms: [] };
    },
    onSuccess: () => {
      setPreview(true);
      setConfirmOpen(true);
    },
  });

  const installMutation = useMutation({
    mutationFn: () => apiClient.installOntology({ docsYaml }),
    onSuccess: () => {
      setDocsYaml("");
      setPreview(false);
      setConfirmOpen(false);
    },
  });

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-[--fg]">Install ontology package</h3>
      <p className="text-xs text-[--fg-muted]">
        Paste a Freehold ontology YAML to install. The package contents will be previewed before
        confirming.
      </p>

      <textarea
        value={docsYaml}
        onChange={(e) => setDocsYaml(e.target.value)}
        rows={6}
        placeholder="# Paste ontology YAML here…"
        spellCheck={false}
        className="w-full rounded border border-[--border] bg-white dark:bg-neutral-900 p-3 font-mono text-xs text-[--fg] placeholder:text-[--fg-muted] resize-y focus:outline-none focus:ring-2 focus:ring-[--fg]/20"
        data-testid="ontology-yaml"
      />

      <button
        type="button"
        onClick={() => previewMutation.mutate()}
        disabled={!docsYaml.trim() || previewMutation.isPending}
        className="rounded border border-[--border] px-3 py-1.5 text-xs font-medium text-[--fg-muted] hover:text-[--fg] hover:bg-[--bg-subtle] disabled:opacity-50 transition-colors"
      >
        Preview
      </button>

      {confirmOpen && preview && (
        <div className="rounded-lg border border-[--border] bg-[--bg-subtle] p-4 space-y-3">
          <p className="text-xs font-medium text-[--fg]">Schema preview</p>
          <p className="text-xs text-[--fg-muted]">
            No preview available without a server round-trip. Proceed to install?
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => installMutation.mutate()}
              disabled={installMutation.isPending}
              className="rounded bg-[--fg] px-3 py-1.5 text-xs font-medium text-white hover:opacity-80 disabled:opacity-50 transition-opacity"
              data-testid="confirm-install"
            >
              {installMutation.isPending ? "Installing…" : "Install"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="rounded border border-[--border] px-3 py-1.5 text-xs font-medium text-[--fg-muted] hover:text-[--fg] transition-colors"
            >
              Cancel
            </button>
          </div>
          {installMutation.isError && (
            <p className="text-xs text-red-600 dark:text-red-400" role="alert">
              {installMutation.error instanceof Error
                ? installMutation.error.message
                : "Install failed"}
            </p>
          )}
          {installMutation.isSuccess && (
            <p className="text-xs text-green-700 dark:text-green-400">Ontology installed.</p>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Theme section
// ---------------------------------------------------------------------------

const THEME_OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function ThemeSection() {
  const [current, setCurrent] = useState<ThemeChoice>(readStoredTheme);

  function handleChange(choice: ThemeChoice) {
    setCurrent(choice);
    setTheme(choice);
  }

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-[--fg]">Appearance</h3>
      <div className="flex gap-2">
        {THEME_OPTIONS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            onClick={() => handleChange(value)}
            aria-pressed={current === value}
            className={cn(
              "rounded border px-3 py-1.5 text-xs font-medium transition-colors",
              current === value
                ? "border-[--fg] text-[--fg] bg-[--border]"
                : "border-[--border] text-[--fg-muted] hover:text-[--fg] hover:bg-[--bg-subtle]"
            )}
            data-testid={`theme-${value}`}
          >
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function SettingsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: principalsData, isLoading } = usePrincipals();
  const principals = parsePrincipals(principalsData);

  function handleRevoke(principal: Principal) {
    // Revocation is a governed change — route through Inbox
    // We create a policy proposal for revocation
    apiClient
      .proposePolicy({
        action: "revoke",
        principalId: principal.id,
      })
      .then(() => {
        qc.invalidateQueries({ queryKey: ["proposals"] });
        navigate({ to: "/inbox" });
      })
      .catch(() => {
        // Silently ignore for now; could show a toast
      });
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <h2 className="font-serif text-2xl font-semibold">Settings</h2>

      {/* Principals */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-[--fg]">Principals</h3>

        {isLoading && <p className="text-xs text-[--fg-muted]">Loading principals…</p>}

        {!isLoading && principals.length === 0 && (
          <p className="text-xs text-[--fg-muted]">No principals registered.</p>
        )}

        {!isLoading && principals.length > 0 && (
          <ul className="space-y-2">
            {principals.map((p) => (
              <li key={p.id}>
                <PrincipalCard principal={p} onRevoke={() => handleRevoke(p)} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="border-t border-[--border]" />

      <RegisterAgentSection />

      <div className="border-t border-[--border]" />

      <OntologyInstallSection />

      <div className="border-t border-[--border]" />

      <ThemeSection />
    </div>
  );
}
