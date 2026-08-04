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

const sampleEntity = {
  type: "User",
  attributes: {
    email: "alice@example.com",
    name: "Alice Smith",
  },
  classifications: ["internal", "pii"],
  edges: {
    in: [],
    out: [{ type: "belongsTo", targetId: "org-42", targetType: "Org" }],
  },
  provenance: {
    author: "claude-code",
    method: "model-assisted",
    changeset: "cafebabe1234",
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

  it("renders provenance footer", async () => {
    await renderPage(sampleEntity);
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
