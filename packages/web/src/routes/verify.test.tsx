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
  useGraphs: vi.fn().mockReturnValue({ graphs: [], defaultGraph: "main" }),
  useActiveGraph: vi.fn().mockReturnValue({ activeGraphId: "main", setActiveGraphId: vi.fn() }),
  useGitProposals: vi
    .fn()
    .mockReturnValue({ data: { proposals: [] }, isLoading: false, isError: false, error: null }),
}));

vi.mock("~/lib/api", () => ({
  GRAPH_STORAGE_KEY: "freehold-graph",
  setActiveGraph: vi.fn(),
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
    registerAgent: vi.fn().mockResolvedValue({}),
    installOntology: vi.fn().mockResolvedValue({}),
    verify: vi.fn(),
  },
}));

function setupHooks(logData: unknown = { entries: [] }) {
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
    data: logData,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useLog>);

  vi.mocked(hooks.usePrincipals).mockReturnValue({
    data: { principals: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.usePrincipals>);
}

async function renderVerify(logData: unknown = { entries: [] }) {
  setupHooks(logData);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/verify"] }),
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

describe("Verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders run button before any verification", async () => {
    vi.mocked(apiClient.verify).mockResolvedValue({ ok: true });
    await renderVerify();
    expect(screen.getByTestId("verify-run")).toBeInTheDocument();
    // Use getAllByText since the sidebar "Verify" nav link might also match
    const matches = screen.getAllByText(/run verification/i);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("shows instruction text before running", async () => {
    vi.mocked(apiClient.verify).mockResolvedValue({ ok: true });
    await renderVerify();
    expect(screen.getByText(/click.*run verification/i)).toBeInTheDocument();
  });

  it("runs verify and shows healthy summary", async () => {
    vi.mocked(apiClient.verify).mockResolvedValue({
      ok: true,
      stateHash: "abcdef1234567890",
    });
    await renderVerify();

    await act(async () => {
      fireEvent.click(screen.getByTestId("verify-run"));
    });

    await waitFor(() => {
      expect(vi.mocked(apiClient.verify)).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByTestId("verify-summary")).toBeInTheDocument();
    });
    expect(screen.getByTestId("verify-summary")).toHaveTextContent("Graph is healthy");
  });

  it("shows three level rows after verification", async () => {
    vi.mocked(apiClient.verify).mockResolvedValue({ ok: true });
    await renderVerify();

    await act(async () => {
      fireEvent.click(screen.getByTestId("verify-run"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("level-integrity")).toBeInTheDocument();
      expect(screen.getByTestId("level-authorship")).toBeInTheDocument();
      expect(screen.getByTestId("level-governance")).toBeInTheDocument();
    });
  });

  it("shows degraded state with reason links when items degraded", async () => {
    vi.mocked(apiClient.verify).mockResolvedValue({
      ok: false,
      degraded: [
        { id: "entity-aaa111", reason: "evidence: none" },
        { id: "entity-bbb222", reason: "hash mismatch" },
      ],
    });
    await renderVerify();

    await act(async () => {
      fireEvent.click(screen.getByTestId("verify-run"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("verify-summary")).toBeInTheDocument();
    });

    expect(screen.getByTestId("verify-summary")).toHaveTextContent("2 degraded item");
    // Reason text (multiple elements possible if text appears in multiple rows)
    const evidenceElems = screen.getAllByText("evidence: none");
    expect(evidenceElems.length).toBeGreaterThan(0);
    const hashMismatches = screen.getAllByText("hash mismatch");
    expect(hashMismatches.length).toBeGreaterThan(0);
    // Links to objects
    const links = screen.getAllByRole("link");
    expect(links.length).toBeGreaterThan(0);
  });

  it("shows changeset timeline when log entries available", async () => {
    vi.mocked(apiClient.verify).mockResolvedValue({ ok: true });
    const logData = {
      entries: [
        { hash: "deadbeef1234567890", author: "claude-code", intent: "create entity", ops: 3 },
        { hash: "cafebabe87654321ab", author: "owner", intent: "approve proposal", ops: 1 },
      ],
    };
    await renderVerify(logData);
    // Timeline should appear even before running verify
    expect(screen.getByText("Changeset timeline")).toBeInTheDocument();
    expect(screen.getByText("claude-code")).toBeInTheDocument();
    expect(screen.getByText("create entity")).toBeInTheDocument();
  });
});
