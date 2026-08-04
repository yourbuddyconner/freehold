import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    registerAgent: vi.fn().mockResolvedValue({}),
    installOntology: vi.fn().mockResolvedValue({}),
    verify: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

const schemaFixture = {
  entityTypes: [
    {
      name: "Preference",
      package: "memory",
      attributes: {
        value: { type: "string", required: true },
        context: { type: "string", required: false },
      },
    },
    {
      name: "Colleague",
      package: "memory",
      extends: "core/Person",
      attributes: {
        slack_id: { type: "string", required: false },
      },
    },
  ],
  edgeTypes: [
    { name: "related_to", domain: "Preference", range: "Preference" },
    { name: "knows", domain: "Colleague", range: "Colleague" },
  ],
  terms: [
    { name: "work" },
    { name: "personal" },
    { name: "meeting", parent: "work" },
    // multi-parent: "sync" is under both "work" and "meeting"
    { name: "sync", parent: "work" },
    { name: "sync", parent: "meeting" },
  ],
};

function setupHooks(
  overrides: { schema?: typeof schemaFixture; pendingProposals?: unknown[] } = {}
) {
  vi.mocked(hooks.usePending).mockReturnValue({
    data: { proposals: overrides.pendingProposals ?? [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.usePending>);

  vi.mocked(hooks.useSchema).mockReturnValue({
    data: overrides.schema ?? { entityTypes: [], edgeTypes: [], terms: [] },
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

  vi.mocked(hooks.usePrincipals).mockReturnValue({
    data: { principals: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.usePrincipals>);
}

async function renderSchema(
  overrides: { schema?: typeof schemaFixture; pendingProposals?: unknown[] } = {}
) {
  setupHooks(overrides);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/schema"] }),
  });
  await act(async () => {
    render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    );
  });
}

describe("Schema viewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders Types tab by default with entity type cards", async () => {
    await renderSchema({ schema: schemaFixture });
    // Both types visible
    const names = screen.getAllByTestId("type-name").map((n) => n.textContent);
    expect(names).toContain("Preference");
    expect(names).toContain("Colleague");
  });

  it("shows inheritance breadcrumb for Colleague ← core/Person", async () => {
    await renderSchema({ schema: schemaFixture });
    expect(screen.getByText("core/Person")).toBeInTheDocument();
  });

  it("shows attribute table for Preference with value and context", async () => {
    await renderSchema({ schema: schemaFixture });
    expect(screen.getByText("value")).toBeInTheDocument();
    expect(screen.getByText("context")).toBeInTheDocument();
  });

  it("shows empty state when no types exist", async () => {
    await renderSchema();
    expect(screen.getByText(/agents can propose new types/i)).toBeInTheDocument();
  });

  it("switches to Edges tab and shows domain→range table", async () => {
    await renderSchema({ schema: schemaFixture });
    const edgesTab = screen.getByRole("tab", { name: /edges/i });
    await act(async () => {
      fireEvent.click(edgesTab);
    });
    expect(screen.getByText("related_to")).toBeInTheDocument();
    expect(screen.getByText("knows")).toBeInTheDocument();
    // Domain and range columns — multiple "Preference" elements OK here
    const cells = screen.getAllByText("Preference");
    expect(cells.length).toBeGreaterThan(0);
    const colleagueCells = screen.getAllByText("Colleague");
    expect(colleagueCells.length).toBeGreaterThan(0);
  });

  it("switches to Taxonomy tab and shows term outline", async () => {
    await renderSchema({ schema: schemaFixture });
    const taxonomyTab = screen.getByRole("tab", { name: /taxonomy/i });
    await act(async () => {
      fireEvent.click(taxonomyTab);
    });
    // Root terms
    expect(screen.getByTestId("term-work")).toBeInTheDocument();
    expect(screen.getByTestId("term-personal")).toBeInTheDocument();
    // Nested: meeting is under work
    expect(screen.getByTestId("term-meeting")).toBeInTheDocument();
  });

  it("taxonomy tab shows multi-parent terms under each parent", async () => {
    await renderSchema({ schema: schemaFixture });
    const taxonomyTab = screen.getByRole("tab", { name: /taxonomy/i });
    await act(async () => {
      fireEvent.click(taxonomyTab);
    });
    // sync appears under both work and meeting — two instances
    const syncs = screen.getAllByTestId("term-sync");
    expect(syncs.length).toBeGreaterThanOrEqual(2);
  });

  it("shows pending amber badge for schema proposals", async () => {
    const pendingProposal = {
      hash: "abc",
      agent: "claude-code",
      intent: "add type",
      summary: "Adds NewType",
      rules: [] as string[],
      diff: [{ key: "NewType", after: { attributes: { foo: "string" } } }],
      isSchemaProposal: true,
    };
    await renderSchema({ schema: schemaFixture, pendingProposals: [pendingProposal] });
    // The pending type card should be rendered
    const pendingBadges = screen.getAllByText("Pending");
    expect(pendingBadges.length).toBeGreaterThan(0);
  });
});
