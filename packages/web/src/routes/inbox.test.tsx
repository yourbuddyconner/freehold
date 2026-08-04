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
}));

vi.mock("~/lib/api", () => ({
  apiClient: {
    proposals: vi.fn(),
    approve: vi.fn().mockResolvedValue({}),
    reject: vi.fn().mockResolvedValue({}),
    recall: vi.fn(),
    getEntity: vi.fn(),
    schema: vi.fn(),
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
  diff: [{ key: "ProjectTask", after: { attributes: { title: "string" } } }],
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
    const rejectBtn = screen.getByRole("button", { name: /^reject$/i });
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

  it("diff toggle shows key labels after clicking Show diff", async () => {
    await renderInbox([normalProposal]);
    const showDiff = screen.getByRole("button", { name: /show diff/i });
    await act(async () => {
      fireEvent.click(showDiff);
    });
    // email is an added key (after only), name is changed (before+after)
    expect(screen.getByText("email:")).toBeInTheDocument();
    expect(screen.getByText("name:")).toBeInTheDocument();
  });
});
