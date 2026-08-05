import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
  useMemoryIndex: vi.fn(),
  useMemoryGraph: vi.fn(),
  useUpdateMemory: vi.fn(),
  useSession: vi.fn(),
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
    schema: vi.fn(),
  },
}));

const schemaFixture = {
  entityTypes: [
    {
      name: "core/Person",
      package: "core",
      attributes: { name: { type: "string", required: true } },
    },
    {
      name: "claude-workspace/Colleague",
      package: "claude-workspace",
      extends: "core/Person",
      attributes: { slack_id: { type: "string", required: false } },
    },
    {
      name: "memory/Preference",
      package: "memory",
      attributes: { statement: { type: "string", required: true } },
    },
  ],
  edgeTypes: [
    {
      name: "claude-workspace/mentioned_in",
      domain: "claude-workspace/Colleague",
      range: "memory/Preference",
    },
  ],
  terms: [{ name: "work" }, { name: "personal" }, { name: "meeting", parent: "work" }],
};

const emptyQuery = { isLoading: false, isError: false, error: null };

function setupHooks(
  overrides: { schema?: typeof schemaFixture; pendingProposals?: unknown[] } = {}
) {
  vi.mocked(hooks.usePending).mockReturnValue({
    data: { proposals: overrides.pendingProposals ?? [] },
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.usePending>);
  vi.mocked(hooks.useSchema).mockReturnValue({
    data: overrides.schema ?? { entityTypes: [], edgeTypes: [], terms: [] },
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.useSchema>);
  vi.mocked(hooks.useRecall).mockReturnValue({
    data: { results: [] },
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.useRecall>);
  vi.mocked(hooks.useVerify).mockReturnValue({
    data: undefined,
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.useVerify>);
  vi.mocked(hooks.useEntity).mockReturnValue({
    data: undefined,
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.useEntity>);
  vi.mocked(hooks.usePolicy).mockReturnValue({
    data: { rules: [] },
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.usePolicy>);
  vi.mocked(hooks.useLog).mockReturnValue({
    data: { entries: [] },
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.useLog>);
  vi.mocked(hooks.usePrincipals).mockReturnValue({
    data: { principals: [] },
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.usePrincipals>);
  vi.mocked(hooks.useMemoryIndex).mockReturnValue({
    data: { results: [] },
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.useMemoryIndex>);
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

describe("Schema reference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("indexes types by package with subtypes filed under their parent", async () => {
    await renderSchema({ schema: schemaFixture });
    const index = screen.getByTestId("type-index");
    expect(within(index).getByText(/^core/)).toBeInTheDocument();
    expect(within(index).getByText(/^memory/)).toBeInTheDocument();
    // Colleague files under core (its parent's package), not its own group
    const coreGroup = within(index).getByText(/^core/).parentElement as HTMLElement;
    expect(within(coreGroup).getByTestId("index-claude-workspace/Colleague")).toBeInTheDocument();
  });

  it("auto-selects the first type so the sheet is never empty", async () => {
    await renderSchema({ schema: schemaFixture });
    expect(screen.getByTestId("type-detail")).toBeInTheDocument();
  });

  it("shows the spec sheet with own and inherited attributes", async () => {
    await renderSchema({ schema: schemaFixture });
    await act(async () => {
      fireEvent.click(screen.getByTestId("index-claude-workspace/Colleague"));
    });
    const detail = screen.getByTestId("type-detail");
    expect(detail).toHaveTextContent("claude-workspace/Colleague");
    expect(detail).toHaveTextContent("slack_id");
    // Inherited section resolves the parent's attributes
    const inherited = screen.getByTestId("inherited-core/Person");
    expect(inherited).toHaveTextContent("name");
    // Relations on the sheet
    expect(detail).toHaveTextContent("mentioned_in");
  });

  it("parent sheet lists subtypes as clickable chips", async () => {
    await renderSchema({ schema: schemaFixture });
    await act(async () => {
      fireEvent.click(screen.getByTestId("index-core/Person"));
    });
    const detail = screen.getByTestId("type-detail");
    expect(detail).toHaveTextContent("Extended by");
    await act(async () => {
      fireEvent.click(within(detail).getByRole("button", { name: "Colleague" }));
    });
    expect(screen.getByTestId("type-detail")).toHaveTextContent("claude-workspace/Colleague");
  });

  it("lists all relations with domain and range", async () => {
    await renderSchema({ schema: schemaFixture });
    const relations = screen.getByTestId("relations-index");
    expect(relations).toHaveTextContent("mentioned_in");
    expect(relations).toHaveTextContent("Colleague");
    expect(relations).toHaveTextContent("Preference");
  });

  it("shows the taxonomy tree", async () => {
    await renderSchema({ schema: schemaFixture });
    expect(screen.getByText("work")).toBeInTheDocument();
    expect(screen.getByText("meeting")).toBeInTheDocument();
  });

  it("shows empty state when no types exist", async () => {
    await renderSchema();
    expect(screen.getByText(/no entity types yet/i)).toBeInTheDocument();
  });
});
