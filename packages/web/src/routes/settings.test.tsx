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
  usePolicy: vi.fn(),
  useLog: vi.fn(),
  usePrincipals: vi.fn(),
  useSession: vi.fn(),
}));

vi.mock("~/lib/api", () => ({
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
    proposePolicy: vi.fn().mockResolvedValue({}),
    registerAgent: vi.fn(),
    installOntology: vi.fn().mockResolvedValue({}),
    verify: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

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
});
