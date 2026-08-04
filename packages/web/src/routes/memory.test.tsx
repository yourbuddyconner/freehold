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

const sampleResult = {
  id: "entity-1",
  type: "User",
  content: "Alice Smith — product designer",
  author: "claude-code",
  approval: "Approved",
  changeset: "deadbeef1234",
  score: 0.9,
};

function setupHooks(
  overrides: {
    results?: (typeof sampleResult)[];
    terms?: { name: string; parent?: string }[];
  } = {}
) {
  vi.mocked(hooks.usePending).mockReturnValue({
    data: { proposals: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.usePending>);
  vi.mocked(hooks.useRecall).mockReturnValue({
    data: { results: overrides.results ?? [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useRecall>);
  vi.mocked(hooks.useSchema).mockReturnValue({
    data: {
      entityTypes: [],
      edgeTypes: [],
      terms: overrides.terms ?? [],
    },
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

async function renderMemory(
  overrides: {
    results?: (typeof sampleResult)[];
    terms?: { name: string; parent?: string }[];
  } = {}
) {
  setupHooks(overrides);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/memory"] }),
  });
  await act(async () => {
    render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    );
  });
}

describe("Memory browser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders search input", async () => {
    await renderMemory();
    expect(screen.getByRole("searchbox", { name: /search memories/i })).toBeInTheDocument();
  });

  it("empty state shows freehold mcp setup snippet when no query", async () => {
    await renderMemory();
    expect(screen.getByText(/freehold mcp setup claude-code/)).toBeInTheDocument();
  });

  it("type filter chips render", async () => {
    await renderMemory();
    expect(screen.getByRole("button", { name: "entity" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "document" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "event" })).toBeInTheDocument();
  });

  it("status filter chips render", async () => {
    await renderMemory();
    expect(screen.getByRole("button", { name: "approved" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "held" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "rejected" })).toBeInTheDocument();
  });

  it("clicking type filter toggles active state (adds bg-[var(--color-accent)] class)", async () => {
    await renderMemory();
    const entityBtn = screen.getByRole("button", { name: "entity" });
    await act(async () => {
      fireEvent.click(entityBtn);
    });
    expect(entityBtn.className).toContain("bg-[var(--color-accent)]");
  });

  it("clicking type filter again deselects it", async () => {
    await renderMemory();
    const entityBtn = screen.getByRole("button", { name: "entity" });
    await act(async () => {
      fireEvent.click(entityBtn);
    });
    expect(entityBtn.className).toContain("bg-[var(--color-accent)]");
    await act(async () => {
      fireEvent.click(entityBtn);
    });
    expect(entityBtn.className).not.toContain("bg-[var(--color-accent)]");
  });

  it("memory cards render with content and provenance when results present and query non-empty", async () => {
    await renderMemory({ results: [sampleResult] });
    const input = screen.getByRole("searchbox", { name: /search memories/i });
    await act(async () => {
      fireEvent.change(input, { target: { value: "alice" } });
    });
    expect(screen.getByText("Alice Smith — product designer")).toBeInTheDocument();
    expect(screen.getByTestId("provenance-author")).toHaveTextContent("claude-code");
  });

  it("shows no results message for non-empty query with empty results", async () => {
    await renderMemory({ results: [] });
    const input = screen.getByRole("searchbox", { name: /search memories/i });
    await act(async () => {
      fireEvent.change(input, { target: { value: "nothing" } });
    });
    expect(screen.getByText(/No memories match your search/)).toBeInTheDocument();
  });

  it("author filter chip renders", async () => {
    await renderMemory();
    expect(screen.getByTestId("author-filter-claude-code")).toBeInTheDocument();
  });

  it("clicking author filter toggles active state (adds bg-[var(--color-accent)] class)", async () => {
    await renderMemory();
    const authorBtn = screen.getByTestId("author-filter-claude-code");
    await act(async () => {
      fireEvent.click(authorBtn);
    });
    expect(authorBtn.className).toContain("bg-[var(--color-accent)]");
  });

  it("toggling author filter composes the query", async () => {
    await renderMemory({ results: [sampleResult] });
    const input = screen.getByRole("searchbox", { name: /search memories/i });

    // Set query
    await act(async () => {
      fireEvent.change(input, { target: { value: "alice" } });
    });

    // Toggle author filter
    const authorBtn = screen.getByTestId("author-filter-claude-code");
    await act(async () => {
      fireEvent.click(authorBtn);
    });

    // Verify useRecall was called with author filter in the filters object
    expect(vi.mocked(hooks.useRecall)).toHaveBeenCalledWith(
      "alice",
      expect.objectContaining({
        author: "claude-code",
      }),
      true
    );
  });
});
