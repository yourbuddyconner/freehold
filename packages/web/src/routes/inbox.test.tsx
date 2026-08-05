import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  useGraphs: vi.fn().mockReturnValue({ graphs: [], defaultGraph: "main" }),
  useActiveGraph: vi.fn().mockReturnValue({ activeGraphId: "main", setActiveGraphId: vi.fn() }),
  useGitProposals: vi
    .fn()
    .mockReturnValue({ data: { proposals: [] }, isLoading: false, isError: false, error: null }),
  useSession: vi.fn().mockReturnValue({
    data: {
      owner: "owner",
      defaultAgent: "claude",
      port: 8710,
      graphs: [],
      defaultGraph: "main",
    },
    isLoading: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("~/components/PierreDiff", () => ({
  PierreDiff: ({ oldText, newText }: { oldText: string; newText: string }) => (
    <pre data-testid="pierre-diff">{`${oldText}\n---\n${newText}`}</pre>
  ),
}));

vi.mock("~/lib/api", () => ({
  GRAPH_STORAGE_KEY: "freehold-graph",
  setActiveGraph: vi.fn(),
  ApiError: class ApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  apiClient: {
    proposals: vi.fn(),
    approve: vi.fn().mockResolvedValue({}),
    reject: vi.fn().mockResolvedValue({}),
    recall: vi.fn(),
    getEntity: vi.fn(),
    schema: vi.fn(),
    listGitProposals: vi.fn().mockResolvedValue({ proposals: [] }),
    decideGitProposal: vi.fn().mockResolvedValue({ outcome: "approved", pushed: true }),
    postGitReview: vi.fn().mockResolvedValue({ reviewId: "rv-1", commentIds: [], status: "saved" }),
    pushGitNotes: vi.fn().mockResolvedValue({ pushed: true }),
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
  rules: [] as string[],
  diff: [
    {
      key: "ProjectTask",
      after: {
        attributes: {
          title: "string",
          description: "string",
          status: "string",
        },
      },
    },
  ],
  isSchemaProposal: true,
};

interface TestProposal {
  hash: string;
  agent: string;
  intent: string;
  summary: string;
  rules: string[];
  diff: { key: string; before?: unknown; after?: unknown }[];
  isSchemaProposal: boolean;
  subject?: { id: string; title: string } | null;
}

function setupHooks(proposals: TestProposal[]) {
  vi.mocked(hooks.usePending).mockReturnValue({
    data: { proposals },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.usePending>);
  vi.mocked(hooks.useRecall).mockReturnValue({
    data: { results: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useRecall>);
  vi.mocked(hooks.useSchema).mockReturnValue({
    data: { entityTypes: [], edgeTypes: [], terms: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useSchema>);
  vi.mocked(hooks.useVerify).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useVerify>);
  vi.mocked(hooks.useGitProposals).mockReturnValue({
    data: { proposals: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useGitProposals>);
  vi.mocked(hooks.useSession).mockReturnValue({
    data: { owner: "owner", defaultAgent: "claude", port: 8710, graphs: [], defaultGraph: "main" },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useSession>);
}

async function renderInbox(proposals: TestProposal[]) {
  setupHooks(proposals);
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
    // The trigger button (outside dialog)
    const triggerBtn = screen.getAllByRole("button", { name: /^approve$/i })[0];
    await act(async () => {
      fireEvent.click(triggerBtn);
    });
    expect(screen.getByText("This signs a decision record with your key.")).toBeInTheDocument();
  });

  it("clicking Approve in dialog fires apiClient.approve with hash", async () => {
    await renderInbox([normalProposal]);
    // Open dialog
    const triggerBtn = screen.getAllByRole("button", { name: /^approve$/i })[0];
    await act(async () => {
      fireEvent.click(triggerBtn);
    });
    // The dialog now has an Approve button inside [role=dialog]
    const dialogApproveBtn = screen
      .getAllByRole("button", { name: /^approve$/i })
      .find((b) => b.closest("[role=dialog]"));
    expect(dialogApproveBtn).toBeDefined();
    await act(async () => {
      // biome-ignore lint/style/noNonNullAssertion: existence asserted above with toBeDefined()
      fireEvent.click(dialogApproveBtn!);
    });
    await waitFor(() => {
      expect(vi.mocked(apiClient.approve)).toHaveBeenCalledWith("abc123");
    });
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

  it("schema proposal renders type definition block with type name and attributes", async () => {
    await renderInbox([schemaProposal]);
    expect(screen.getByText("Type definition:")).toBeInTheDocument();
    expect(screen.getByText("ProjectTask")).toBeInTheDocument();
    // Check for at least one attribute row
    expect(screen.getByText("title:")).toBeInTheDocument();
    // The table should have at least 3 rows (title, description, status)
    const tables = screen.queryAllByRole("table");
    expect(tables.length).toBeGreaterThan(0);
  });

  it("shows the target row and previews the node on hover", async () => {
    vi.mocked(hooks.useEntity).mockReturnValue({
      data: {
        type: "memory/Note@1",
        attributes: { content: "Quarterly planning kickoff\nfull note body" },
        classifications: ["work@1"],
      },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.useEntity>);
    await renderInbox([
      { ...normalProposal, subject: { id: "node-1", title: "Quarterly planning kickoff" } },
    ]);
    const link = screen.getByTestId("subject-link-node-1");
    expect(link).toHaveTextContent("Quarterly planning kickoff");
    expect(screen.queryByTestId("subject-preview")).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.mouseEnter(link.parentElement as HTMLElement);
    });
    const preview = screen.getByTestId("subject-preview");
    expect(preview).toHaveTextContent("memory/Note");
    expect(preview).toHaveTextContent("full note body");
    expect(preview).toHaveTextContent("work");
  });

  it("hover preview says so when the target node is gone", async () => {
    vi.mocked(hooks.useEntity).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("not found"),
    } as unknown as ReturnType<typeof hooks.useEntity>);
    await renderInbox([{ ...normalProposal, subject: { id: "ghost-1", title: "ghost-1…" } }]);
    await act(async () => {
      fireEvent.mouseEnter(screen.getByTestId("subject-link-ghost-1").parentElement as HTMLElement);
    });
    expect(screen.getByTestId("subject-preview")).toHaveTextContent(/no longer exists/i);
  });

  it("diff toggle shows aria-expanded attribute", async () => {
    await renderInbox([normalProposal]);
    const showDiff = screen.getByRole("button", { name: /show diff/i });
    expect(showDiff).toHaveAttribute("aria-expanded", "false");
    await act(async () => {
      fireEvent.click(showDiff);
    });
    expect(showDiff).toHaveAttribute("aria-expanded", "true");
  });

  it("diff toggle shows key labels after clicking Show diff", async () => {
    await renderInbox([normalProposal]);
    const showDiff = screen.getByRole("button", { name: /show diff/i });
    await act(async () => {
      fireEvent.click(showDiff);
    });
    // email is an added key (after only), name is changed (before+after)
    const diffEl = screen.getByTestId("pierre-diff");
    expect(diffEl.textContent).toContain("email:");
    expect(diffEl.textContent).toContain("name:");
  });

  describe("Inbox — git proposals (repo graph)", () => {
    const gitProposal = {
      sha: "deadbeef1234",
      ref: "refs/heads/main",
      author: "alice",
      timestamp: "2026-01-01T00:00:00Z",
      message: "feat: add new feature",
      target: "refs/heads/main",
      matched: ["require-reviewer"],
      checklist: [{ role: "reviewer" }],
      unmet: ["reviewer"],
      decided: "undecided" as const,
      paths: [
        { verb: "M", path: "src/lib.rs", regions: ["core"], indexed: true },
        { verb: "A", path: "src/new.rs", regions: [], indexed: false },
      ],
    };

    function setupRepoGraph() {
      vi.mocked(hooks.useGraphs).mockReturnValue({
        graphs: [{ id: "repo-1", name: "my-repo", kind: "repo" }],
        defaultGraph: "repo-1",
      });
      vi.mocked(hooks.useActiveGraph).mockReturnValue({
        activeGraphId: "repo-1",
        setActiveGraphId: vi.fn(),
      });
    }

    async function renderRepoInbox() {
      setupHooks([]);
      setupRepoGraph();
      vi.mocked(apiClient.listGitProposals).mockResolvedValue({ proposals: [gitProposal] });
      vi.mocked(hooks.useGitProposals).mockReturnValue({
        data: { proposals: [gitProposal] },
        isLoading: false,
        isError: false,
        error: null,
      } as unknown as ReturnType<typeof hooks.useGitProposals>);
      vi.mocked(hooks.useSession).mockReturnValue({
        data: {
          owner: "alice",
          defaultAgent: "claude",
          port: 8710,
          graphs: [],
          defaultGraph: "main",
        },
        isLoading: false,
        isError: false,
        error: null,
      } as unknown as ReturnType<typeof hooks.useSession>);

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

    it("renders Commits section for repo graphs", async () => {
      await renderRepoInbox();
      expect(screen.getByRole("region", { name: /commits/i })).toBeInTheDocument();
    });

    it("renders git proposal card with short sha and message", async () => {
      await renderRepoInbox();
      expect(screen.getByText("deadbee")).toBeInTheDocument();
      expect(screen.getByText("feat: add new feature")).toBeInTheDocument();
    });

    it("renders checklist rows with met/unmet indicators", async () => {
      await renderRepoInbox();
      const checklist = screen.getByTestId("checklist");
      expect(checklist).toBeInTheDocument();
      const unmetIndicator = within(checklist).getByLabelText("unmet");
      expect(unmetIndicator).toBeInTheDocument();
    });

    it("renders region badge for indexed path", async () => {
      await renderRepoInbox();
      expect(screen.getByTestId("region-badge")).toHaveTextContent("core");
    });

    it("renders not-yet-indexed badge for unindexed path", async () => {
      await renderRepoInbox();
      expect(screen.getByTestId("not-indexed-badge")).toBeInTheDocument();
      expect(screen.getByTestId("not-indexed-badge")).toHaveTextContent("not yet indexed");
    });

    it("renders undecided chip for undecided proposal", async () => {
      await renderRepoInbox();
      expect(screen.getByTestId("decided-chip")).toHaveTextContent("undecided");
    });

    it("disables governance actions and shows reason on key-missing 409", async () => {
      setupHooks([]);
      setupRepoGraph();
      vi.mocked(hooks.useGitProposals).mockReturnValue({
        data: { proposals: [gitProposal] },
        isLoading: false,
        isError: false,
        error: null,
      } as unknown as ReturnType<typeof hooks.useGitProposals>);
      vi.mocked(hooks.useSession).mockReturnValue({
        data: {
          owner: "alice",
          defaultAgent: "claude",
          port: 8710,
          graphs: [],
          defaultGraph: "main",
        },
        isLoading: false,
        isError: false,
        error: null,
      } as unknown as ReturnType<typeof hooks.useSession>);

      const { ApiError } = await import("~/lib/api");
      vi.mocked(apiClient.decideGitProposal).mockRejectedValue(
        new ApiError("key-missing", "no signing key for alice", 409)
      );

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

      const rejectBtn = screen.getByRole("button", { name: /reject/i });
      await act(async () => {
        fireEvent.click(rejectBtn);
      });
      await waitFor(() => {
        expect(screen.getByTestId("key-missing-notice")).toBeInTheDocument();
      });
      expect(screen.getByRole("button", { name: /reject/i })).toBeDisabled();
      expect(
        screen.getAllByRole("button", { name: /approve/i }).find((b) => !b.closest("[role=dialog]"))
      ).toBeDisabled();
    });

    it("shows saved-locally notice and retry button when pushed:false", async () => {
      setupHooks([]);
      setupRepoGraph();
      vi.mocked(hooks.useGitProposals).mockReturnValue({
        data: { proposals: [gitProposal] },
        isLoading: false,
        isError: false,
        error: null,
      } as unknown as ReturnType<typeof hooks.useGitProposals>);
      vi.mocked(hooks.useSession).mockReturnValue({
        data: {
          owner: "alice",
          defaultAgent: "claude",
          port: 8710,
          graphs: [],
          defaultGraph: "main",
        },
        isLoading: false,
        isError: false,
        error: null,
      } as unknown as ReturnType<typeof hooks.useSession>);
      vi.mocked(apiClient.decideGitProposal).mockResolvedValue({
        outcome: "approved",
        pushed: false,
        pushError: "remote: Connection refused",
      });

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

      const rejectBtn = screen.getByRole("button", { name: /reject/i });
      await act(async () => {
        fireEvent.click(rejectBtn);
      });
      await waitFor(() => {
        expect(screen.getByTestId("saved-locally-notice")).toBeInTheDocument();
      });
      expect(screen.getByTestId("retry-push")).toBeInTheDocument();
      // Verify the request body includes verdict and by fields
      expect(vi.mocked(apiClient.decideGitProposal)).toHaveBeenCalledWith(
        "deadbeef1234",
        expect.objectContaining({
          verdict: "reject",
          by: "alice",
        })
      );
    });

    it("composer posts correct body shape on submit", async () => {
      setupHooks([]);
      setupRepoGraph();
      vi.mocked(hooks.useGitProposals).mockReturnValue({
        data: { proposals: [gitProposal] },
        isLoading: false,
        isError: false,
        error: null,
      } as unknown as ReturnType<typeof hooks.useGitProposals>);
      vi.mocked(hooks.useSession).mockReturnValue({
        data: {
          owner: "alice",
          defaultAgent: "claude",
          port: 8710,
          graphs: [],
          defaultGraph: "main",
        },
        isLoading: false,
        isError: false,
        error: null,
      } as unknown as ReturnType<typeof hooks.useSession>);
      vi.mocked(apiClient.postGitReview).mockResolvedValue({
        reviewId: "rv-1",
        commentIds: [],
        status: "saved",
      });

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

      const writeReviewBtn = screen.getByRole("button", { name: /write review/i });
      await act(async () => {
        fireEvent.click(writeReviewBtn);
      });

      const bodyTextarea = screen.getByRole("textbox", { name: /review body/i });
      await act(async () => {
        fireEvent.change(bodyTextarea, { target: { value: "Looks good!" } });
      });

      const submitBtn = screen.getByRole("button", { name: /submit review/i });
      await act(async () => {
        fireEvent.click(submitBtn);
      });

      await waitFor(() => {
        expect(vi.mocked(apiClient.postGitReview)).toHaveBeenCalledWith(
          "deadbeef1234",
          expect.objectContaining({
            verdict: "approve",
            body: "Looks good!",
            by: "alice",
          })
        );
      });
    });

    it("renders incomplete outcome with unmet requirements when decision outcome is incomplete", async () => {
      setupHooks([]);
      setupRepoGraph();
      vi.mocked(hooks.useGitProposals).mockReturnValue({
        data: { proposals: [gitProposal] },
        isLoading: false,
        isError: false,
        error: null,
      } as unknown as ReturnType<typeof hooks.useGitProposals>);
      vi.mocked(hooks.useSession).mockReturnValue({
        data: {
          owner: "alice",
          defaultAgent: "claude",
          port: 8710,
          graphs: [],
          defaultGraph: "main",
        },
        isLoading: false,
        isError: false,
        error: null,
      } as unknown as ReturnType<typeof hooks.useSession>);
      vi.mocked(apiClient.decideGitProposal).mockResolvedValue({
        outcome: "incomplete",
        unmet: ["reviewer quorum", "security review"],
      });

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

      const approveBtn = screen.getByRole("button", { name: /approve/i });
      await act(async () => {
        fireEvent.click(approveBtn);
      });

      const confirmBtn = screen
        .getAllByRole("button", { name: /approve/i })
        .find((b) => b.closest("[role=dialog]"));
      expect(confirmBtn).toBeDefined();
      if (!confirmBtn) return;

      await act(async () => {
        fireEvent.click(confirmBtn);
      });

      await waitFor(() => {
        expect(screen.getByTestId("incomplete-unmet")).toBeInTheDocument();
      });
      expect(screen.getByText("reviewer quorum")).toBeInTheDocument();
      expect(screen.getByText("security review")).toBeInTheDocument();
    });

    it("clicking Retry calls pushGitNotes and does not call decideGitProposal again", async () => {
      setupHooks([]);
      setupRepoGraph();
      vi.mocked(hooks.useGitProposals).mockReturnValue({
        data: { proposals: [gitProposal] },
        isLoading: false,
        isError: false,
        error: null,
      } as unknown as ReturnType<typeof hooks.useGitProposals>);
      vi.mocked(hooks.useSession).mockReturnValue({
        data: {
          owner: "alice",
          defaultAgent: "claude",
          port: 8710,
          graphs: [],
          defaultGraph: "main",
        },
        isLoading: false,
        isError: false,
        error: null,
      } as unknown as ReturnType<typeof hooks.useSession>);
      vi.mocked(apiClient.decideGitProposal).mockResolvedValue({
        outcome: "approved",
        pushed: false,
        pushError: "Connection timeout",
      });
      vi.mocked(apiClient.pushGitNotes).mockResolvedValue({ pushed: true });

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

      const rejectBtn = screen.getByRole("button", { name: /reject/i });
      await act(async () => {
        fireEvent.click(rejectBtn);
      });

      await waitFor(() => {
        expect(screen.getByTestId("saved-locally-notice")).toBeInTheDocument();
      });

      const retryBtn = screen.getByTestId("retry-push");
      await act(async () => {
        fireEvent.click(retryBtn);
      });

      await waitFor(() => {
        expect(vi.mocked(apiClient.pushGitNotes)).toHaveBeenCalledWith("deadbeef1234");
      });
      // Verify decideGitProposal was only called once (for the initial reject)
      expect(vi.mocked(apiClient.decideGitProposal)).toHaveBeenCalledTimes(1);
    });

    it("disables both Approve and Reject when key-missing 409", async () => {
      setupHooks([]);
      setupRepoGraph();
      vi.mocked(hooks.useGitProposals).mockReturnValue({
        data: { proposals: [gitProposal] },
        isLoading: false,
        isError: false,
        error: null,
      } as unknown as ReturnType<typeof hooks.useGitProposals>);
      vi.mocked(hooks.useSession).mockReturnValue({
        data: {
          owner: "alice",
          defaultAgent: "claude",
          port: 8710,
          graphs: [],
          defaultGraph: "main",
        },
        isLoading: false,
        isError: false,
        error: null,
      } as unknown as ReturnType<typeof hooks.useSession>);

      const { ApiError } = await import("~/lib/api");
      vi.mocked(apiClient.decideGitProposal).mockRejectedValue(
        new ApiError("key-missing", "no signing key for alice", 409)
      );

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

      const approveBtn = screen.getByRole("button", { name: /approve/i });
      const rejectBtn = screen.getByRole("button", { name: /reject/i });

      // Initially both should be enabled
      expect(approveBtn).not.toBeDisabled();
      expect(rejectBtn).not.toBeDisabled();

      // Click reject to trigger the error
      await act(async () => {
        fireEvent.click(rejectBtn);
      });

      await waitFor(() => {
        expect(screen.getByTestId("key-missing-notice")).toBeInTheDocument();
      });

      // Now both should be disabled
      expect(screen.getByRole("button", { name: /approve/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /reject/i })).toBeDisabled();
    });
  });

  it("clicking approve button and then confirming invalidates queries", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    vi.mocked(hooks.usePending).mockReturnValue({
      data: { proposals: [normalProposal] },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.usePending>);
    vi.mocked(hooks.useRecall).mockReturnValue({
      data: { results: [] },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.useRecall>);
    vi.mocked(hooks.useSchema).mockReturnValue({
      data: { entityTypes: [], edgeTypes: [], terms: [] },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.useSchema>);
    vi.mocked(hooks.useVerify).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.useVerify>);
    vi.mocked(hooks.useGitProposals).mockReturnValue({
      data: { proposals: [] },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.useGitProposals>);
    vi.mocked(hooks.useSession).mockReturnValue({
      data: {
        owner: "owner",
        defaultAgent: "claude",
        port: 8710,
        graphs: [],
        defaultGraph: "main",
      },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.useSession>);

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

    // Open dialog
    const triggerBtn = screen.getAllByRole("button", { name: /^approve$/i })[0];
    await act(async () => {
      fireEvent.click(triggerBtn);
    });

    // Click approve in dialog
    const dialogApproveBtn = screen
      .getAllByRole("button", { name: /^approve$/i })
      .find((b) => b.closest("[role=dialog]"));
    expect(dialogApproveBtn).toBeDefined();

    await act(async () => {
      // biome-ignore lint/style/noNonNullAssertion: existence asserted above with toBeDefined()
      fireEvent.click(dialogApproveBtn!);
    });

    // Verify invalidateQueries was called with the proposals key
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["proposals"] })
    );
    invalidateSpy.mockRestore();
  });
});
