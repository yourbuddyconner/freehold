import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiClient } from "~/lib/api";
import * as hooks from "~/lib/hooks";
import { routeTree } from "~/routes/../routeTree.gen";

vi.mock("~/lib/hooks", () => ({
  usePending: vi.fn(),
  useRecall: vi.fn(),
  useVerify: vi.fn(),
  useSchema: vi.fn(),
  useEntity: vi.fn(),
  usePolicy: vi.fn(),
  useLog: vi.fn(),
  usePrincipals: vi.fn(),
  useSession: vi.fn(),
  useGraphs: vi.fn().mockReturnValue({ graphs: [], defaultGraph: "main" }),
  useListGraphs: vi
    .fn()
    .mockReturnValue({ data: { graphs: [] }, isLoading: false, isError: false, error: null }),
  useActiveGraph: vi.fn().mockReturnValue({ activeGraphId: "main", setActiveGraphId: vi.fn() }),
  useListGraphs: vi.fn().mockReturnValue({ data: { graphs: [] }, isLoading: false }),
  useGitProposals: vi
    .fn()
    .mockReturnValue({ data: { proposals: [] }, isLoading: false, isError: false, error: null }),
}));

vi.mock("~/lib/api", () => {
  class ApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.name = "ApiError";
      this.code = code;
      this.status = status;
    }
  }

  return {
    GRAPH_STORAGE_KEY: "freehold-graph",
    setActiveGraph: vi.fn(),
    ApiError,
    apiClient: {
      proposals: vi.fn(),
      approve: vi.fn().mockResolvedValue({}),
      reject: vi.fn().mockResolvedValue({}),
      recall: vi.fn(),
      getEntity: vi.fn(),
      schema: vi.fn(),
      getPolicy: vi.fn(),
      log: vi.fn(),
      principals: vi.fn(),
      addPrincipal: vi.fn(),
      proposePolicy: vi.fn().mockResolvedValue({}),
      registerAgent: vi.fn(),
      installOntology: vi.fn().mockResolvedValue({}),
      verify: vi.fn().mockResolvedValue({ ok: true }),
      getConnector: vi.fn().mockResolvedValue({ configured: false, status: {} }),
      putConnector: vi.fn(),
      pollConnector: vi.fn(),
      getConnectorManifest: vi.fn(),
      updateGraph: vi.fn().mockResolvedValue({}),
      onboardRepo: vi.fn().mockResolvedValue({
        steps: [
          { step: "allod init", status: "skipped", detail: ".allod/graph.yaml already exists" },
          {
            step: "generate key",
            status: "ok",
            detail: "/home/user/.local/share/allod/keys/owner.yaml",
          },
          { step: "register graph", status: "ok", detail: "id=myrepo" },
          { step: "git index", status: "ok" },
        ],
        entry: { id: "myrepo", path: "/home/user/repos/myrepo", name: "myrepo" },
        keyPath: "/home/user/.local/share/allod/keys/owner.yaml",
        principal: "owner",
      }),
    },
  };
});

const principalsFixture = {
  principals: [
    {
      id: "owner-key-abc",
      name: "Conner Swann",
      kind: "owner",
      fingerprint: "SHA256:abcdef1234567890",
      status: "active",
    },
    {
      id: "agent-claude-code",
      name: "claude-code",
      kind: "agent",
      fingerprint: "SHA256:fedcba0987654321",
      status: "active",
    },
  ],
};

function setupHooks(principalsData: unknown = principalsFixture) {
  vi.mocked(hooks.usePrincipals).mockReturnValue({
    data: principalsData,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.usePrincipals>);

  vi.mocked(hooks.usePending).mockReturnValue({
    data: { proposals: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.usePending>);

  vi.mocked(hooks.useSchema).mockReturnValue({
    data: { entityTypes: [], edgeTypes: [], terms: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useSchema>);

  vi.mocked(hooks.useRecall).mockReturnValue({
    data: { results: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useRecall>);

  vi.mocked(hooks.useVerify).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useVerify>);

  vi.mocked(hooks.useEntity).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useEntity>);

  vi.mocked(hooks.usePolicy).mockReturnValue({
    data: { rules: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.usePolicy>);

  vi.mocked(hooks.useLog).mockReturnValue({
    data: { entries: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useLog>);

  vi.mocked(hooks.useSession).mockReturnValue({
    data: { defaultAgent: "claude-code", embedder: "transformers", port: 8710 },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useSession>);
}

async function renderSettings(principalsData: unknown = principalsFixture) {
  setupHooks(principalsData);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/settings"] }),
  });
  await act(async () => {
    render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    );
  });
  return { qc };
}

describe("Settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders principal cards with names and fingerprints", async () => {
    await renderSettings();
    expect(screen.getByText("Conner Swann")).toBeInTheDocument();
    // "claude-code" may appear in both the principals list and the embedder section
    expect(screen.getAllByText("claude-code").length).toBeGreaterThan(0);
    expect(screen.getByText("SHA256:abcdef1234567890")).toBeInTheDocument();
  });

  it("shows kind badges for principals", async () => {
    await renderSettings();
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();
  });

  it("register agent flow: typing name and submitting shows MCP snippet", async () => {
    vi.mocked(apiClient.registerAgent).mockResolvedValue({
      name: "my-agent",
      mcpSnippet: '{"mcpServers": {"freehold": {}}}',
    });
    await renderSettings();

    const input = screen.getByTestId("agent-name-input");
    await act(async () => {
      fireEvent.change(input, { target: { value: "my-agent" } });
    });

    const registerBtn = screen.getByTestId("register-agent-btn");
    await act(async () => {
      fireEvent.click(registerBtn);
    });

    await waitFor(() => {
      expect(vi.mocked(apiClient.registerAgent)).toHaveBeenCalledWith({ name: "my-agent" });
    });

    await waitFor(() => {
      expect(screen.getByTestId("mcp-snippet")).toBeInTheDocument();
    });
    expect(screen.getByTestId("mcp-snippet")).toHaveTextContent("freehold");
  });

  it("register agent shows fallback snippet when server returns no mcpSnippet", async () => {
    vi.mocked(apiClient.registerAgent).mockResolvedValue({ name: "fallback-agent" });
    await renderSettings();

    const input = screen.getByTestId("agent-name-input");
    await act(async () => {
      fireEvent.change(input, { target: { value: "fallback-agent" } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("register-agent-btn"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("mcp-snippet")).toBeInTheDocument();
    });
    // Fallback snippet should still reference "freehold"
    expect(screen.getByTestId("mcp-snippet")).toHaveTextContent("freehold");
  });

  it("register btn is disabled when name is empty", async () => {
    vi.mocked(apiClient.registerAgent).mockResolvedValue({});
    await renderSettings();
    expect(screen.getByTestId("register-agent-btn")).toBeDisabled();
  });

  it("theme switcher buttons are rendered", async () => {
    await renderSettings();
    expect(screen.getByTestId("theme-system")).toBeInTheDocument();
    expect(screen.getByTestId("theme-light")).toBeInTheDocument();
    expect(screen.getByTestId("theme-dark")).toBeInTheDocument();
  });

  it("theme switcher persists selection — dark button becomes pressed", async () => {
    await renderSettings();
    const darkBtn = screen.getByTestId("theme-dark");
    await act(async () => {
      fireEvent.click(darkBtn);
    });
    // Pressing dark should mark it as selected
    expect(darkBtn).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("theme-light")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("theme-system")).toHaveAttribute("aria-pressed", "false");
  });

  it("theme switcher marks selected button as pressed", async () => {
    await renderSettings();
    const lightBtn = screen.getByTestId("theme-light");
    await act(async () => {
      fireEvent.click(lightBtn);
    });
    expect(lightBtn).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("theme-dark")).toHaveAttribute("aria-pressed", "false");
  });

  it("shows empty state when no principals", async () => {
    await renderSettings({ principals: [] });
    expect(screen.getByText(/no principals registered/i)).toBeInTheDocument();
  });

  it("Add principal form is present", async () => {
    await renderSettings();
    expect(screen.getByTestId("principal-name-input")).toBeInTheDocument();
    expect(screen.getByTestId("add-principal-btn")).toBeInTheDocument();
  });

  it("Add principal btn is disabled when name is empty", async () => {
    await renderSettings();
    const btn = screen.getByTestId("add-principal-btn");
    expect(btn).toBeDisabled();
  });

  it("Add principal submits and shows key path result", async () => {
    vi.mocked(apiClient.addPrincipal).mockResolvedValue({
      name: "reviewer-demo",
      kind: "user",
      admission: "saved",
      keyPath: "/home/user/.local/share/allod/keys/abc123/reviewer-demo.yaml",
      instruction:
        "Copy /home/user/.local/share/allod/keys/abc123/reviewer-demo.yaml to the reviewer's machine under the same path.",
    });

    await renderSettings();

    const input = screen.getByTestId("principal-name-input");
    await act(async () => {
      fireEvent.change(input, { target: { value: "reviewer-demo" } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("add-principal-btn"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("principal-key-path")).toBeInTheDocument();
    });
    expect(screen.getByTestId("principal-key-path")).toHaveTextContent("reviewer-demo.yaml");
  });
});

describe("API token masking", () => {
  const REAL_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.testpayload.sig";

  function setTokenMeta(value: string) {
    let meta = document.querySelector<HTMLMetaElement>('meta[name="freehold-token"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "freehold-token";
      document.head.appendChild(meta);
    }
    meta.content = value;
  }

  function clearTokenMeta() {
    const meta = document.querySelector('meta[name="freehold-token"]');
    if (meta) meta.remove();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setTokenMeta(REAL_TOKEN);
  });

  afterEach(() => {
    clearTokenMeta();
  });

  it("hides real token by default — masked string shown, real value absent from DOM", async () => {
    await renderSettings();
    const display = screen.getByTestId("api-token-display");
    expect(display).not.toHaveTextContent(REAL_TOKEN);
    expect(display).toHaveTextContent("••••");
    // Real token must not appear anywhere in the page
    expect(document.body.textContent).not.toContain(REAL_TOKEN);
  });

  it("View toggle reveals the real token", async () => {
    await renderSettings();
    const toggle = screen.getByTestId("token-visibility-toggle");
    expect(toggle).toHaveTextContent("View");
    await act(async () => {
      fireEvent.click(toggle);
    });
    const display = screen.getByTestId("api-token-display");
    expect(display).toHaveTextContent(REAL_TOKEN);
    expect(toggle).toHaveTextContent("Hide");
  });

  it("Hide toggle re-masks the token after revealing it", async () => {
    await renderSettings();
    const toggle = screen.getByTestId("token-visibility-toggle");
    await act(async () => {
      fireEvent.click(toggle);
    });
    // Now visible — click Hide
    await act(async () => {
      fireEvent.click(toggle);
    });
    const display = screen.getByTestId("api-token-display");
    expect(display).not.toHaveTextContent(REAL_TOKEN);
    expect(display).toHaveTextContent("••••");
  });

  it("Copy button copies the real token regardless of visibility state", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    await renderSettings();
    // Token is hidden — copy should still use the real value
    const copyBtn = screen.getByTestId("token-copy-btn");
    await act(async () => {
      fireEvent.click(copyBtn);
    });
    expect(writeText).toHaveBeenCalledWith(REAL_TOKEN);
  });
});

describe("Connector section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.getConnector).mockResolvedValue({ configured: false, status: {} });
  });

  it("renders connector section", async () => {
    await renderSettings();
    await waitFor(() => {
      expect(screen.getByTestId("connector-section")).toBeInTheDocument();
    });
  });

  it("shows 'no credential found' error when putConnector returns 409 no-credential", async () => {
    vi.mocked(apiClient.putConnector).mockRejectedValue(
      new ApiError("no-credential", "no credential found", 409)
    );

    await renderSettings();

    await waitFor(() => {
      expect(screen.getByTestId("connect-btn")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("connect-btn"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("connect-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("connect-error")).toHaveTextContent(
      "No GitHub credential found. Install the gh CLI and run `gh auth login`."
    );
  });

  it("webhook toggle is disabled when public URL field is empty", async () => {
    vi.mocked(apiClient.getConnector).mockResolvedValue({
      configured: true,
      config: {
        mode: "app",
        owner: "test-owner",
        repo: "test-repo",
        pollIntervalSec: 300,
        webhooksEnabled: false,
        appId: "123",
      },
      status: {},
    });

    await renderSettings();

    await waitFor(() => {
      expect(screen.getByTestId("webhooks-toggle")).toBeInTheDocument();
    });

    const toggle = screen.getByTestId("webhooks-toggle");
    // publicUrl field is empty by default → toggle must be disabled
    expect(toggle).toBeDisabled();
  });

  it("poll-result shows formatted output after polling", async () => {
    vi.mocked(apiClient.getConnector).mockResolvedValue({
      configured: true,
      config: {
        mode: "credential",
        owner: "test-owner",
        repo: "test-repo",
        pollIntervalSec: 300,
        webhooksEnabled: false,
      },
      status: {},
    });
    vi.mocked(apiClient.pollConnector).mockResolvedValue({
      events: 5,
      unchanged: 2,
      errors: [],
    });

    await renderSettings();

    await waitFor(() => {
      expect(screen.getByTestId("poll-btn")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("poll-btn"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("poll-result")).toBeInTheDocument();
    });
    expect(screen.getByTestId("poll-result")).toHaveTextContent("5 events, 2 unchanged, 0 errors");
  });

  it("publicUrl input populates from stored config after query resolves", async () => {
    vi.mocked(apiClient.getConnector).mockResolvedValue({
      configured: true,
      config: {
        mode: "app",
        owner: "test-owner",
        repo: "test-repo",
        pollIntervalSec: 300,
        webhooksEnabled: false,
        appId: "123",
        publicUrl: "https://stored.example.com",
      },
      status: {},
    });

    await renderSettings();

    await waitFor(() => {
      expect(screen.getByTestId("public-url-input")).toHaveValue("https://stored.example.com");
    });
  });

  it("manifest form renders with action URL when manifest data is available", async () => {
    vi.mocked(apiClient.getConnectorManifest).mockResolvedValue({
      manifestUrl: "https://github.com/settings/apps/new",
      manifest: { name: "test-app" },
      state: "abc123",
    });

    await renderSettings();

    await waitFor(() => {
      expect(screen.getByTestId("mode-app")).toBeInTheDocument();
    });

    // Switch to app mode
    await act(async () => {
      fireEvent.click(screen.getByTestId("mode-app"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("create-app-btn")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("create-app-btn"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("manifest-form")).toBeInTheDocument();
    });

    const form = screen.getByTestId("manifest-form");
    expect(form).toHaveAttribute("action", "https://github.com/settings/apps/new");
    expect(screen.getByTestId("manifest-submit")).toBeInTheDocument();
  });
});
