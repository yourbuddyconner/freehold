import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { type Principal, PrincipalCard } from "~/components/PrincipalCard";
import { ApiError, apiClient } from "~/lib/api";
import { cn } from "~/lib/cn";
import { useListGraphs, usePrincipals, useSession } from "~/lib/hooks";
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

/** Fixed-length mask string shown when the token is hidden. */
const TOKEN_MASK = "••••••••••••••••••••••••";

function ApiTokenSection() {
  const token = readBearerToken();
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-(--fg)">API bearer token</h3>
      <p className="text-xs text-(--fg-muted)">
        Used to authenticate API and MCP requests to Freehold.{" "}
        <strong className="text-amber-700 dark:text-amber-400">Keep this secret.</strong>
      </p>
      {token ? (
        <div className="relative">
          <code
            className="block border border-(--border) bg-(--bg-subtle) px-3 py-2 font-mono text-xs text-(--fg) overflow-auto break-all pr-28"
            data-testid="api-token-display"
            aria-label={visible ? "API bearer token (visible)" : "API bearer token (hidden)"}
          >
            {visible ? token : TOKEN_MASK}
          </code>
          <div className="absolute top-1.5 right-2 flex items-center gap-1">
            <button
              type="button"
              onClick={() => setVisible((v) => !v)}
              data-testid="token-visibility-toggle"
              aria-label={visible ? "Hide API token" : "View API token"}
              className="flex items-center border border-(--border) bg-white dark:bg-neutral-900 px-2 py-1 text-[10px] text-(--fg-muted) hover:text-(--fg) transition-colors"
            >
              {visible ? "Hide" : "View"}
            </button>
            <button
              type="button"
              onClick={handleCopy}
              aria-label="Copy API token"
              data-testid="token-copy-btn"
              className="flex items-center gap-1 border border-(--border) bg-white dark:bg-neutral-900 px-2 py-1 text-[10px] text-(--fg-muted) hover:text-(--fg) transition-colors"
            >
              {copied ? (
                <Check className="h-3 w-3 text-green-600" aria-hidden />
              ) : (
                <Copy className="h-3 w-3" aria-hidden />
              )}
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-(--fg-muted) italic">
          Token not available — open this page from Freehold (not the Vite dev server without a
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
      <h3 className="text-sm font-semibold text-(--fg)">Embedder configuration</h3>
      {isLoading && <p className="text-xs text-(--fg-muted)">Loading…</p>}
      {data && (
        <dl className="border border-(--border) bg-(--bg-subtle) p-3 space-y-2 text-xs">
          <div className="flex gap-4">
            <dt className="text-(--fg-muted) w-28 shrink-0">Backend</dt>
            <dd className="font-mono text-(--fg)" data-testid="embedder-backend">
              {data.embedder}
            </dd>
          </div>
          {data.defaultAgent != null && (
            <div className="flex gap-4">
              <dt className="text-(--fg-muted) w-28 shrink-0">Default agent</dt>
              <dd className="font-mono text-(--fg)" data-testid="embedder-default-agent">
                {data.defaultAgent}
              </dd>
            </div>
          )}
          <div className="flex gap-4">
            <dt className="text-(--fg-muted) w-28 shrink-0">Port</dt>
            <dd className="font-mono text-(--fg)">{data.port}</dd>
          </div>
        </dl>
      )}
      {!isLoading && !data && (
        <p className="text-xs text-(--fg-muted) italic">
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
      <h3 className="text-sm font-semibold text-(--fg)">Register agent</h3>
      <p className="text-xs text-(--fg-muted)">
        Register a new agent to get an MCP config snippet you can paste into your AI tool.
      </p>

      {result ? (
        <div className="space-y-3">
          <p className="text-xs text-green-700 dark:text-green-400">
            Agent <strong>{result.name}</strong> registered.
          </p>
          <div className="relative">
            <pre
              className="border border-(--border) bg-(--bg-subtle) p-3 font-mono text-xs text-(--fg) overflow-auto"
              data-testid="mcp-snippet"
            >
              {snippet}
            </pre>
            <button
              type="button"
              onClick={() => handleCopy(snippet)}
              aria-label="Copy MCP snippet"
              className="absolute top-2 right-2 flex items-center gap-1 border border-(--border) bg-white dark:bg-neutral-900 px-2 py-1 text-[10px] text-(--fg-muted) hover:text-(--fg) transition-colors"
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
            className="text-xs text-(--fg-muted) underline underline-offset-2 hover:text-(--fg) transition-colors"
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
            className="flex-1 border border-(--border) bg-white dark:bg-neutral-900 px-3 py-1.5 text-xs text-(--fg) placeholder:text-(--fg-muted) focus:outline-none focus:ring-2 focus:ring-(--fg)/20"
            data-testid="agent-name-input"
            onKeyDown={(e) => {
              if (e.key === "Enter" && agentName.trim()) registerMutation.mutate();
            }}
          />
          <button
            type="button"
            onClick={() => registerMutation.mutate()}
            disabled={!agentName.trim() || registerMutation.isPending}
            className="bg-(--fg) text-white font-mono text-[12px] uppercase tracking-wide px-3 py-1.5 disabled:opacity-50 transition-opacity"
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
      <h3 className="text-sm font-semibold text-(--fg)">Install ontology package</h3>
      <p className="text-xs text-(--fg-muted)">
        Paste a Freehold ontology YAML to install. The package contents will be previewed before
        confirming.
      </p>

      <textarea
        value={docsYaml}
        onChange={(e) => setDocsYaml(e.target.value)}
        rows={6}
        placeholder="# Paste ontology YAML here…"
        spellCheck={false}
        className="w-full border border-(--border) bg-white dark:bg-neutral-900 p-3 font-mono text-xs text-(--fg) placeholder:text-(--fg-muted) resize-y focus:outline-none focus:ring-2 focus:ring-(--fg)/20"
        data-testid="ontology-yaml"
      />

      <button
        type="button"
        onClick={() => previewMutation.mutate()}
        disabled={!docsYaml.trim() || previewMutation.isPending}
        className="border border-(--border) px-3 py-1.5 text-xs font-medium text-(--fg-muted) hover:text-(--fg) hover:bg-(--bg-subtle) disabled:opacity-50 transition-colors"
      >
        Preview
      </button>

      {confirmOpen && preview && (
        <div className="border border-(--border) bg-(--bg-subtle) p-4 space-y-3">
          <p className="text-xs font-medium text-(--fg)">Schema preview</p>
          <p className="text-xs text-(--fg-muted)">
            No preview available without a server round-trip. Proceed to install?
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => installMutation.mutate()}
              disabled={installMutation.isPending}
              className="bg-(--fg) text-white font-mono text-[12px] uppercase tracking-wide px-3 py-1.5 disabled:opacity-50 transition-opacity"
              data-testid="confirm-install"
            >
              {installMutation.isPending ? "Installing…" : "Install"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="border border-(--border) px-3 py-1.5 text-xs font-medium text-(--fg-muted) hover:text-(--fg) transition-colors"
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
      <h3 className="text-sm font-semibold text-(--fg)">Appearance</h3>
      <div className="flex gap-2">
        {THEME_OPTIONS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            onClick={() => handleChange(value)}
            aria-pressed={current === value}
            className={cn(
              "border px-3 py-1.5 text-xs font-medium transition-colors",
              current === value
                ? "border-(--fg) text-(--fg) bg-(--border)"
                : "border-(--border) text-(--fg-muted) hover:text-(--fg) hover:bg-(--bg-subtle)"
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
// Connector section
// ---------------------------------------------------------------------------

interface ConnectorConfig {
  mode: "credential" | "app";
  owner?: string;
  repo?: string;
  pollIntervalSec?: number;
  webhooksEnabled?: boolean;
  appId?: string;
  appSlug?: string;
  installationId?: string;
  publicUrl?: string;
}

interface ConnectorStatus {
  configured: boolean;
  config?: ConnectorConfig;
  status: { lastPollAt?: string; lastErrors?: string[] };
}

function ConnectorSection() {
  const qc = useQueryClient();

  const connectorQuery = useQuery<ConnectorStatus>({
    queryKey: ["connector"],
    queryFn: () => apiClient.getConnector() as Promise<ConnectorStatus>,
    retry: false,
  });

  const cfg = connectorQuery.data?.config;

  // Mode picker state
  const [selectedMode, setSelectedMode] = useState<"credential" | "app">("credential");

  // Poll result state
  const [pollResult, setPollResult] = useState<{
    events: number;
    unchanged: number;
    errors: string[];
  } | null>(null);

  // Connect mutation (credential mode)
  const connectMut = useMutation({
    mutationFn: () => apiClient.putConnector({ mode: "credential" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["connector"] }),
  });

  // Poll mutation
  const pollMut = useMutation({
    mutationFn: () => apiClient.pollConnector(),
    onSuccess: (result) => setPollResult(result),
  });

  // Manifest form state
  const [manifestData, setManifestData] = useState<{
    manifestUrl: string;
    manifest: Record<string, unknown>;
    state: string;
  } | null>(null);
  const manifestMut = useMutation({
    mutationFn: () => apiClient.getConnectorManifest(),
    onSuccess: (data) => setManifestData(data),
  });

  // Webhook state
  const [publicUrl, setPublicUrl] = useState(cfg?.publicUrl ?? "");
  useEffect(() => {
    if (cfg?.publicUrl) {
      setPublicUrl(cfg.publicUrl);
    }
  }, [cfg?.publicUrl]);
  const webhookMut = useMutation({
    mutationFn: (enabled: boolean) =>
      apiClient.putConnector({ webhooksEnabled: enabled, publicUrl: publicUrl || undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["connector"] }),
  });

  // Connect error message
  let connectError: string | null = null;
  if (connectMut.isError) {
    const err = connectMut.error;
    if (err instanceof ApiError) {
      if (err.code === "no-credential") {
        connectError = "No GitHub credential found. Install the gh CLI and run `gh auth login`.";
      } else if (err.code === "missing-origin-remote") {
        connectError = "Graph has no origin remote configured.";
      } else {
        connectError = err.message;
      }
    } else {
      connectError = err instanceof Error ? err.message : "Connect failed";
    }
  }

  // App status
  let appStatus: string | null = null;
  if (cfg?.mode === "app") {
    if (cfg.installationId) appStatus = "installed";
    else if (cfg.appId) appStatus = "awaiting installation";
    else appStatus = "app created";
  }

  return (
    <section className="space-y-4" data-testid="connector-section">
      <h3 className="text-sm font-semibold text-(--fg)">GitHub connector</h3>
      <p className="text-xs text-(--fg-muted)">
        Connect this graph to a GitHub repository to ingest PR comments as review nodes.
      </p>

      {connectorQuery.isLoading && <p className="text-xs text-(--fg-muted)">Loading…</p>}

      {!connectorQuery.isLoading && (
        <>
          {/* Mode picker */}
          <div className="flex gap-2 items-center">
            <span className="text-xs text-(--fg-muted) w-16 shrink-0">Mode</span>
            <div className="flex gap-1">
              {(["credential", "app"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setSelectedMode(m)}
                  aria-pressed={selectedMode === m}
                  data-testid={`mode-${m}`}
                  className={cn(
                    "border px-2 py-1 text-xs font-mono transition-colors",
                    selectedMode === m
                      ? "border-(--fg) text-(--fg) bg-(--border)"
                      : "border-(--border) text-(--fg-muted) hover:text-(--fg)"
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
            {cfg && (
              <span className="text-[10px] text-(--fg-muted) font-mono ml-2">
                current: {cfg.mode}
              </span>
            )}
          </div>

          {/* Credential mode */}
          {selectedMode === "credential" && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => connectMut.mutate()}
                disabled={connectMut.isPending}
                data-testid="connect-btn"
                className="border border-(--border) px-3 py-1.5 text-xs font-medium text-(--fg-muted) hover:text-(--fg) disabled:opacity-50 transition-colors"
              >
                {connectMut.isPending ? "Connecting…" : "Connect with credential"}
              </button>
              {connectMut.isSuccess && (
                <p
                  className="text-xs text-green-700 dark:text-green-400"
                  data-testid="connect-success"
                >
                  Connector configured.
                </p>
              )}
              {connectError && (
                <p
                  className="text-xs text-red-600 dark:text-red-400"
                  role="alert"
                  data-testid="connect-error"
                >
                  {connectError}
                </p>
              )}
            </div>
          )}

          {/* App mode wizard */}
          {selectedMode === "app" && (
            <div className="space-y-3">
              {appStatus && (
                <p className="text-xs text-(--fg-muted)" data-testid="app-status">
                  Status: <span className="font-mono">{appStatus}</span>
                </p>
              )}
              <div>
                <p className="text-xs text-(--fg-muted) mb-2">
                  Create a GitHub App using GitHub's manifest flow. A form will be submitted to
                  GitHub.
                </p>
                {!manifestData ? (
                  <button
                    type="button"
                    onClick={() => manifestMut.mutate()}
                    disabled={manifestMut.isPending}
                    data-testid="create-app-btn"
                    className="border border-(--border) px-3 py-1.5 text-xs font-medium text-(--fg-muted) hover:text-(--fg) disabled:opacity-50 transition-colors"
                  >
                    {manifestMut.isPending ? "Preparing…" : "Create GitHub App"}
                  </button>
                ) : (
                  <form method="post" action={manifestData.manifestUrl} data-testid="manifest-form">
                    <input
                      type="hidden"
                      name="manifest"
                      value={JSON.stringify(manifestData.manifest)}
                    />
                    <input type="hidden" name="state" value={manifestData.state} />
                    <button
                      type="submit"
                      className="bg-(--fg) text-white font-mono text-[12px] uppercase tracking-wide px-3 py-1.5"
                      data-testid="manifest-submit"
                    >
                      Open GitHub to finish setup
                    </button>
                  </form>
                )}
                {manifestMut.isError && (
                  <p className="text-xs text-red-600 dark:text-red-400" role="alert">
                    {manifestMut.error instanceof Error
                      ? manifestMut.error.message
                      : "Failed to prepare manifest"}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Webhook toggle — shown for app mode only in the UI.
              The server also accepts webhooksEnabled on credential-mode PUT; this
              UI intentionally restricts the toggle to app mode since credential
              mode polling does not use webhooks. */}
          {cfg?.mode === "app" && (
            <div className="space-y-2 border-t border-(--border) pt-3">
              <div className="flex items-center gap-3">
                <label
                  htmlFor="public-url-input"
                  className="text-xs text-(--fg-muted) w-24 shrink-0"
                >
                  Public URL
                </label>
                <input
                  type="text"
                  id="public-url-input"
                  value={publicUrl}
                  onChange={(e) => setPublicUrl(e.target.value)}
                  placeholder="https://example.com"
                  data-testid="public-url-input"
                  className="flex-1 border border-(--border) bg-white dark:bg-neutral-900 px-2 py-1 text-xs font-mono text-(--fg) placeholder:text-(--fg-muted) focus:outline-none"
                />
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-(--fg-muted) w-24 shrink-0">Webhooks</span>
                <button
                  type="button"
                  aria-pressed={cfg.webhooksEnabled ?? false}
                  disabled={!publicUrl.trim() || webhookMut.isPending}
                  data-testid="webhooks-toggle"
                  onClick={() => webhookMut.mutate(!(cfg.webhooksEnabled ?? false))}
                  className={cn(
                    "border px-3 py-1 text-xs font-mono transition-colors",
                    cfg.webhooksEnabled
                      ? "border-green-400 text-green-700 dark:text-green-300"
                      : "border-(--border) text-(--fg-muted)",
                    (!publicUrl.trim() || webhookMut.isPending) && "opacity-50 cursor-not-allowed"
                  )}
                >
                  {cfg.webhooksEnabled ? "enabled" : "disabled"}
                </button>
                {!publicUrl.trim() && (
                  <span className="text-[10px] text-(--fg-muted)">
                    enter a public URL to enable webhooks
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Poll now */}
          {connectorQuery.data?.configured && (
            <div className="space-y-2 border-t border-(--border) pt-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => pollMut.mutate()}
                  disabled={pollMut.isPending}
                  data-testid="poll-btn"
                  className="border border-(--border) px-3 py-1.5 text-xs font-medium text-(--fg-muted) hover:text-(--fg) disabled:opacity-50 transition-colors"
                >
                  {pollMut.isPending ? "Polling…" : "Poll now"}
                </button>
                {pollResult && (
                  <span className="text-xs text-(--fg-muted) font-mono" data-testid="poll-result">
                    {pollResult.events} events, {pollResult.unchanged} unchanged,{" "}
                    {pollResult.errors.length} errors
                  </span>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Repositories section
// ---------------------------------------------------------------------------

function RepositoriesSection() {
  const qc = useQueryClient();
  const { data: graphsData, isLoading } = useListGraphs();
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [principal, setPrincipal] = useState("");
  const [onboardResult, setOnboardResult] = useState<{
    steps: Array<{ step: string; status: string; detail?: string }>;
    entry: { id: string; path: string; name: string };
    keyPath: string;
    principal: string;
  } | null>(null);

  const repoGraphs = (graphsData?.graphs ?? []).filter((g) => g.kind === "repo");

  const onboardMutation = useMutation({
    mutationFn: () =>
      apiClient.onboardRepo({
        path: path.trim(),
        name: name.trim() || undefined,
        principal: principal.trim() || undefined,
      }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["list-graphs"] });
      setOnboardResult(data as typeof onboardResult);
      setPath("");
      setName("");
      setPrincipal("");
    },
  });

  return (
    <section className="space-y-3" data-testid="repositories-section">
      <h3 className="text-sm font-semibold text-(--fg)">Repositories</h3>
      <p className="text-xs text-(--fg-muted)">
        Register a local repository checkout for code review. The daemon must have read access to
        the path.
      </p>

      {/* Registered repo graphs */}
      {isLoading && <p className="text-xs text-(--fg-muted)">Loading repositories…</p>}
      {!isLoading && repoGraphs.length > 0 && (
        <ul className="space-y-1.5">
          {repoGraphs.map((g) => (
            <li
              key={g.id}
              className="flex items-center gap-2 border border-(--border) bg-(--bg-subtle) px-3 py-2"
            >
              <span className="font-mono text-xs text-(--fg) truncate flex-1">{g.path}</span>
              <span className="text-xs text-(--fg-muted)">{g.id}</span>
            </li>
          ))}
        </ul>
      )}
      {!isLoading && repoGraphs.length === 0 && (
        <p className="text-xs text-(--fg-muted)">No repositories registered.</p>
      )}

      {/* Onboard result */}
      {onboardResult && (
        <div className="space-y-2 border border-(--border) bg-(--bg-subtle) p-3">
          <p className="text-xs font-medium text-(--fg)">
            Registered: <span className="font-mono">{onboardResult.entry.id}</span>
          </p>
          <ul className="space-y-0.5">
            {onboardResult.steps.map((s) => (
              <li key={s.step} className="text-xs font-mono text-(--fg-muted)">
                {s.status === "ok" ? "✓" : s.status === "skipped" ? "–" : "✗"} {s.step}
                {s.detail ? ` (${s.detail})` : ""}
              </li>
            ))}
          </ul>
          <p className="text-xs text-(--fg-muted)">
            Key: <span className="font-mono">{onboardResult.keyPath}</span>
          </p>
        </div>
      )}

      {/* Error display */}
      {onboardMutation.isError && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {onboardMutation.error instanceof Error
            ? onboardMutation.error.message
            : "Onboarding failed."}
        </p>
      )}

      {/* Add form */}
      <div className="space-y-2 border-t border-(--border) pt-3">
        <p className="text-xs font-medium text-(--fg)">Add repository</p>
        <div className="space-y-1.5">
          <input
            type="text"
            placeholder="/absolute/path/to/repo"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            data-testid="repo-path-input"
            className="w-full border border-(--border) bg-(--bg) px-3 py-1.5 font-mono text-xs text-(--fg) placeholder-text-(--fg-muted) focus:outline-none focus:ring-1 focus:ring-(--color-accent)"
          />
          <div className="flex gap-1.5">
            <input
              type="text"
              placeholder="Display name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 border border-(--border) bg-(--bg) px-3 py-1.5 text-xs text-(--fg) placeholder-text-(--fg-muted) focus:outline-none focus:ring-1 focus:ring-(--color-accent)"
            />
            <input
              type="text"
              placeholder="Principal (default: owner)"
              value={principal}
              onChange={(e) => setPrincipal(e.target.value)}
              className="flex-1 border border-(--border) bg-(--bg) px-3 py-1.5 text-xs text-(--fg) placeholder-text-(--fg-muted) focus:outline-none focus:ring-1 focus:ring-(--color-accent)"
            />
          </div>
        </div>
        <button
          type="button"
          onClick={() => onboardMutation.mutate()}
          disabled={!path.trim() || onboardMutation.isPending}
          data-testid="onboard-repo-btn"
          className="border border-(--border) px-3 py-1.5 text-xs font-medium text-(--fg-muted) hover:text-(--fg) disabled:opacity-50 transition-colors"
        >
          {onboardMutation.isPending ? "Registering…" : "Register"}
        </button>
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
    // allod policy engine can record it as a pending-approval proposal.
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
          SETTINGS
        </span>
      </div>
      <h2 className="text-2xl font-semibold tracking-tight">Settings</h2>

      {/* Principals */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-(--fg)">Principals</h3>

        {isLoading && <p className="text-xs text-(--fg-muted)">Loading principals…</p>}

        {!isLoading && principals.length === 0 && (
          <p className="text-xs text-(--fg-muted)">No principals registered.</p>
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
          className="border border-red-300 bg-red-50 dark:bg-red-950 dark:border-red-800 px-3 py-2 text-xs text-red-600 dark:text-red-400"
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
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm bg-white dark:bg-neutral-900 border border-(--border) p-6 shadow-xl space-y-4">
            <Dialog.Title className="text-base font-semibold text-(--fg)">
              Revoke principal
            </Dialog.Title>
            <Dialog.Description className="text-sm text-(--fg-muted)">
              Revoking is a governed change — it creates a proposal you approve in the Inbox.
            </Dialog.Description>
            <div className="flex gap-2 justify-end">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="border border-(--border) px-3 py-1.5 text-xs font-medium text-(--fg) hover:bg-(--bg-subtle) transition-colors"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                onClick={confirmRevoke}
                className="border border-[var(--color-status-rejected)] text-[var(--color-status-rejected)] font-mono text-[12px] uppercase px-3 py-1.5"
                data-testid="confirm-revoke"
              >
                Revoke
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <div className="border-t border-(--border)" />

      <RepositoriesSection />

      <div className="border-t border-(--border)" />

      <ApiTokenSection />

      <div className="border-t border-(--border)" />

      <EmbedderSection />

      <div className="border-t border-(--border)" />

      <RegisterAgentSection />

      <div className="border-t border-(--border)" />

      <OntologyInstallSection />

      <div className="border-t border-(--border)" />

      <ConnectorSection />

      <div className="border-t border-(--border)" />

      <ThemeSection />
    </div>
  );
}
