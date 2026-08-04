import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type React from "react";
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
}));

vi.mock("~/lib/api", () => ({
  apiClient: {
    proposals: vi.fn(),
    schema: vi.fn(),
  },
}));

// React Flow needs real DOM measurement; stub it with clickable node buttons.
interface FlowStubProps {
  nodes: Array<{ id: string; data: Record<string, unknown> }>;
  edges: Array<{ id: string; label?: string }>;
  onNodeClick?: (e: unknown, node: { id: string }) => void;
  children?: React.ReactNode;
}
vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ nodes, edges, onNodeClick, children }: FlowStubProps) => (
    <div data-testid="flow-stub">
      {nodes.map((n) => (
        <button type="button" key={n.id} onClick={(e) => onNodeClick?.(e, n)}>
          {String((n.data as { shortName?: string }).shortName ?? n.id)}
        </button>
      ))}
      <ul>
        {edges.map((e) => (
          <li key={e.id} data-testid={`flow-edge-${e.id}`}>
            {e.label ?? e.id}
          </li>
        ))}
      </ul>
      {children}
    </div>
  ),
  Background: () => null,
  Handle: () => null,
  Position: { Top: "top", Bottom: "bottom" },
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

describe("Schema ontology map", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders every entity type as a node", async () => {
    await renderSchema({ schema: schemaFixture });
    const map = within(screen.getByTestId("ontology-map"));
    expect(map.getByRole("button", { name: "Person" })).toBeInTheDocument();
    expect(map.getByRole("button", { name: "Colleague" })).toBeInTheDocument();
    expect(map.getByRole("button", { name: "Preference" })).toBeInTheDocument();
  });

  it("draws the inheritance edge and the labeled relation edge", async () => {
    await renderSchema({ schema: schemaFixture });
    expect(screen.getByTestId("flow-edge-x:claude-workspace/Colleague")).toBeInTheDocument();
    expect(screen.getByTestId("flow-edge-r:claude-workspace/mentioned_in")).toHaveTextContent(
      "mentioned_in"
    );
  });

  it("clicking a type opens its detail panel with attributes and relations", async () => {
    await renderSchema({ schema: schemaFixture });
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("ontology-map")).getByRole("button", { name: "Colleague" })
      );
    });
    const detail = screen.getByTestId("type-detail");
    expect(detail).toHaveTextContent("claude-workspace/Colleague");
    expect(detail).toHaveTextContent("slack_id");
    expect(detail).toHaveTextContent("mentioned_in");
  });

  it("detail panel lists subtypes for a parent type", async () => {
    await renderSchema({ schema: schemaFixture });
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("ontology-map")).getByRole("button", { name: "Person" })
      );
    });
    expect(screen.getByTestId("type-detail")).toHaveTextContent("claude-workspace/Colleague");
  });

  it("shows the taxonomy tree below the map", async () => {
    await renderSchema({ schema: schemaFixture });
    expect(screen.getByText("Taxonomy")).toBeInTheDocument();
    expect(screen.getByText("work")).toBeInTheDocument();
    expect(screen.getByText("meeting")).toBeInTheDocument();
  });

  it("shows empty state when no types exist", async () => {
    await renderSchema();
    expect(screen.getByText(/no entity types yet/i)).toBeInTheDocument();
  });
});
