import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as hooks from "~/lib/hooks";
import { MemoryDetailPage } from "./memory.$id";

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

interface LinkMockProps {
  to: string;
  params?: Record<string, string>;
  children?: React.ReactNode;
  [key: string]: unknown;
}

// Mock the Link component to avoid router context issues in tests
vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual("@tanstack/react-router");
  return {
    ...actual,
    Link: ({ to, params, children, ...props }: LinkMockProps) => {
      const href = typeof to === "string" && params?.id ? `${to.replace("$id", params.id)}` : to;
      return (
        <a href={href} {...props}>
          {children}
        </a>
      );
    },
  };
});

// Uses the REAL API shape from GET /api/v1/entities/:id (EntityView)
const sampleEntity = {
  type: "User",
  attributes: {
    email: "alice@example.com",
    name: "Alice Smith",
  },
  classifications: ["internal", "pii"],
  // Real shape: flat EdgeView[] with direction "outgoing"/"incoming", from/to prefixed IDs
  edges: [
    {
      id: "edge-1",
      type: "belongsTo",
      from: "node:entity-1",
      to: "node:org-42",
      direction: "outgoing" as const,
    },
  ],
  provenance: {
    derived_by: "principal:claude-code",
    method: "model-assisted",
  },
  revisions: [
    { hash: "deadbeef1234abcd", timestamp: "2026-01-01T00:00:00Z" },
    { hash: "aabbccdd11223344", timestamp: "2025-12-01T00:00:00Z" },
  ],
};

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

async function renderPage(entityData: typeof sampleEntity | undefined, loading = false) {
  vi.mocked(hooks.useEntity).mockReturnValue({
    data: entityData,
    isLoading: loading,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useEntity>);

  // Mock usePending for AppShell
  vi.mocked(hooks.usePending).mockReturnValue({
    data: { proposals: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.usePending>);

  // Mock useRecall for AppShell
  vi.mocked(hooks.useRecall).mockReturnValue({
    data: { results: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useRecall>);

  // Mock useSchema for AppShell
  vi.mocked(hooks.useSchema).mockReturnValue({
    data: { entityTypes: [], edgeTypes: [], terms: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useSchema>);

  // Mock useVerify for AppShell
  vi.mocked(hooks.useVerify).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useVerify>);

  await act(async () => {
    render(
      <Wrapper>
        <MemoryDetailPage entityId="entity-1" />
      </Wrapper>
    );
  });
}

describe("MemoryDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders attribute table with key-value rows", async () => {
    await renderPage(sampleEntity);
    expect(screen.getByText("email")).toBeInTheDocument();
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("name")).toBeInTheDocument();
    expect(screen.getByText("Alice Smith")).toBeInTheDocument();
  });

  it("renders classifications as chips", async () => {
    await renderPage(sampleEntity);
    expect(screen.getByText("internal")).toBeInTheDocument();
    expect(screen.getByText("pii")).toBeInTheDocument();
  });

  it("renders edges grouped by type with direction label", async () => {
    await renderPage(sampleEntity);
    expect(screen.getByText("belongsTo")).toBeInTheDocument();
    // targetId is extracted from the "to" field: "node:org-42" → "org-42"
    expect(screen.getByText("org-42")).toBeInTheDocument();
    expect(screen.getByText("Out")).toBeInTheDocument();
  });

  it("renders lineage trail with Latest label on first revision", async () => {
    await renderPage(sampleEntity);
    expect(screen.getByText("Latest")).toBeInTheDocument();
    // Hash is truncated to 12 chars + ellipsis
    expect(screen.getByText("deadbeef1234…")).toBeInTheDocument();
    expect(screen.getByText("aabbccdd1122…")).toBeInTheDocument();
  });

  it("renders provenance footer extracting author from derived_by", async () => {
    await renderPage(sampleEntity);
    // provenance.derived_by = "principal:claude-code" → author = "claude-code"
    expect(screen.getByTestId("provenance-author")).toHaveTextContent("claude-code");
    expect(screen.getByTestId("provenance-method")).toHaveTextContent("model-assisted");
  });

  it("shows loading state when isLoading is true", async () => {
    await renderPage(undefined, true);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows not-found message when data is undefined", async () => {
    await renderPage(undefined, false);
    expect(screen.getByText("Entity not found.")).toBeInTheDocument();
  });
});
