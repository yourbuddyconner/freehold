import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { type Principal, PrincipalCard } from "~/components/PrincipalCard";
import { apiClient } from "~/lib/api";
import { cn } from "~/lib/cn";
import { usePrincipals, useSession } from "~/lib/hooks";
import { type ThemeChoice, readStoredTheme, setTheme } from "~/lib/theme";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/settings",
  component: SettingsPage,
});

// ---------------------------------------------------------------------------
// Read the bearer token injected by the daemon into the meta tag.
// The token is available client-side this way so it never touches localStorage
// or the JS bundle. This is the same mechanism used by packages/web/src/lib/api.ts.
// ---------------------------------------------------------------------------

function readBearerToken(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="freehold-token"]');
  return meta?.content ?? "";
}

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
// API token display
// ---------------------------------------------------------------------------

function ApiTokenSection() {
  const token = readBearerToken();
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-[--fg]">API bearer token</h3>
      <p className="text-xs text-[--fg-muted]">
        Used to authenticate API and MCP requests to this daemon.{" "}
        <strong className="text-amber-700 dark:text-amber-400">Keep this secret.</strong>
      </p>
      {token ? (
        <div className="relative">
          <code
            className="block rounded border border-[--border] bg-[--bg-subtle] px-3 py-2 font-mono text-xs text-[--fg] overflow-auto break-all pr-16"
            data-testid="api-token"
          >
            {token}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            aria-label="Copy API token"
            className="absolute top-1.5 right-2 flex items-center gap-1 rounded border border-[--border] bg-white dark:bg-neutral-900 px-2 py-1 text-[10px] text-[--fg-muted] hover:text-[--fg] transition-colors"
          >
            {copied ? (
              <Check className="h-3 w-3 text-green-600" aria-hidden />
            ) : (
              <Copy className="h-3 w-3" aria-hidden />
            )}
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      ) : (
        <p className="text-xs text-[--fg-muted] italic">
          Token not available — open this page via the daemon (not the Vite dev server without a
          running daemon).
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Embedder config display
// ---------------------------------------------------------------------------

function EmbedderSection() {
  const { data, isLoading } = useSession();

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-[--fg]">Embedder configuration</h3>
      {isLoading && <p className="text-xs text-[--fg-muted]">Loading…</p>}
      {data && (
        <dl className="rounded border border-[--border] bg-[--bg-subtle] p-3 space-y-2 text-xs">
          <div className="flex gap-4">
            <dt className="text-[--fg-muted] w-28 shrink-0">Backend</dt>
            <dd className="font-mono text-[--fg]" data-testid="embedder-backend">
              {data.embedder}
            </dd>
          </div>
          {data.defaultAgent != null && (
            <div className="flex gap-4">
              <dt className="text-[--fg-muted] w-28 shrink-0">Default agent</dt>
              <dd className="font-mono text-[--fg]" data-testid="embedder-default-agent">
                {data.defaultAgent}
              </dd>
            </div>
          )}
          <div className="flex gap-4">
            <dt className="text-[--fg-muted] w-28 shrink-0">Port</dt>
            <dd className="font-mono text-[--fg]">{data.port}</dd>
          </div>
        </dl>
      )}
      {!isLoading && !data && (
        <p className="text-xs text-[--fg-muted] italic">
          Could not load session config. Is the daemon running?
        </p>
      )}
    </section>
  );
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
      // DECLARED OMISSION: The spec requires Schema-viewer component preview of the ontology
      // package contents before confirming install. No server-side preview endpoint exists;
      // a real preview requires a POST /api/v1/schema/preview round-trip that returns
      // SchemaDescription. Until that endpoint is added, the preview is a client-side stub
      // returning empty data, and the confirm dialog tells the user as much.
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

  // Pending revocation confirmation
  const [revokeTarget, setRevokeTarget] = useState<Principal | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  function confirmRevoke() {
    if (!revokeTarget) return;
    const target = revokeTarget;
    setRevokeTarget(null);
    setRevokeError(null);
    // Revocation is a governed change: propose a policy amendment via the real API shape.
    // The API requires { policy_yaml: string }. We encode the intent as YAML so the
    // allod policy engine can record it as a held proposal.
    const policyYaml = `# Revoke principal ${target.id}\nrevoke:\n  principal: "${target.id}"\n`;
    apiClient
      .proposePolicy({ policy_yaml: policyYaml })
      .then(() => {
        qc.invalidateQueries({ queryKey: ["proposals"] });
        navigate({ to: "/inbox" });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "Revocation proposal failed";
        setRevokeError(msg);
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
                <PrincipalCard principal={p} onRevoke={() => setRevokeTarget(p)} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Revocation confirmation dialog */}
      {revokeError && (
        <div
          className="rounded border border-red-300 bg-red-50 dark:bg-red-950 dark:border-red-800 px-3 py-2 text-xs text-red-600 dark:text-red-400"
          role="alert"
        >
          Revocation failed: {revokeError}
        </div>
      )}

      <Dialog.Root
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRevokeTarget(null);
            setRevokeError(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm rounded-lg bg-white dark:bg-neutral-900 border border-[--border] p-6 shadow-xl space-y-4">
            <Dialog.Title className="text-base font-semibold text-[--fg]">
              Revoke principal
            </Dialog.Title>
            <Dialog.Description className="text-sm text-[--fg-muted]">
              Revoking is a governed change — it creates a proposal you approve in the Inbox.
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
              <button
                type="button"
                onClick={confirmRevoke}
                className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 transition-colors"
                data-testid="confirm-revoke"
              >
                Revoke
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <div className="border-t border-[--border]" />

      <ApiTokenSection />

      <div className="border-t border-[--border]" />

      <EmbedderSection />

      <div className="border-t border-[--border]" />

      <RegisterAgentSection />

      <div className="border-t border-[--border]" />

      <OntologyInstallSection />

      <div className="border-t border-[--border]" />

      <ThemeSection />
    </div>
  );
}
