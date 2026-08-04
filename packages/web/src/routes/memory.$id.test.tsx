import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
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
  useMemoryIndex: vi.fn(),
  useUpdateMemory: vi.fn(),
  useSession: vi.fn(),
}));

vi.mock("~/lib/api", () => ({
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
  },
}));

vi.mock("~/components/DocEditor", () => ({
  DocEditor: ({
    initial,
    onSave,
    onCancel,
  }: {
    initial: string;
    onSave: (next: string) => void;
    onCancel: () => void;
  }) => (
    <div data-testid="doc-editor">
      <button
        type="button"
        data-testid="mock-save"
        onClick={() => onSave(`${initial}\nedited line`)}
      >
        Save
      </button>
      <button type="button" data-testid="mock-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  ),
}));

vi.mock("~/components/PierreDiff", () => ({
  PierreDiff: ({ oldText, newText }: { oldText: string; newText: string }) => (
    <pre data-testid="pierre-diff">{`${oldText}\n---\n${newText}`}</pre>
  ),
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
  rev: "rev-0",
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

  vi.mocked(hooks.useMemoryIndex).mockReturnValue({
    data: {
      results: [
        {
          id: "org-42",
          type: "memory/Org@1",
          title: "Acme Org",
          approval: "saved",
          author: "claude",
          updatedAt: "2026-08-04T00:00:00.000Z",
          terms: [],
        },
      ],
    },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useMemoryIndex>);

  vi.mocked(hooks.useUpdateMemory).mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof hooks.useUpdateMemory>);

  vi.mocked(hooks.useSession).mockReturnValue({
    data: { defaultAgent: "claude", embedder: "hash", port: 8710, owner: "owner" },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useSession>);

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
    const table = within(screen.getByTestId("memory-properties"));
    expect(table.getByText("email")).toBeInTheDocument();
    expect(table.getByText("alice@example.com")).toBeInTheDocument();
    expect(table.getByText("name")).toBeInTheDocument();
    expect(table.getByText("Alice Smith")).toBeInTheDocument();
  });

  it("renders classifications as chips", async () => {
    await renderPage(sampleEntity);
    expect(screen.getByText("internal")).toBeInTheDocument();
    expect(screen.getByText("pii")).toBeInTheDocument();
  });

  it("renders connections with peer titles from the index", async () => {
    await renderPage(sampleEntity);
    expect(screen.getByText("belongsTo →")).toBeInTheDocument();
    // Peer title resolved from the workspace index
    expect(screen.getByTestId("connection-org-42")).toHaveTextContent("Acme Org");
  });

  it("renders markdown content when the node has a prose body", async () => {
    await renderPage({
      ...sampleEntity,
      attributes: { content: "# Heading\n\nSome **bold** body" },
    } as unknown as typeof sampleEntity);
    const content = within(screen.getByTestId("memory-content"));
    expect(content.getByRole("heading", { name: "Heading" })).toBeInTheDocument();
    expect(content.getByText("bold")).toBeInTheDocument();
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

  it("edit → save → commit calls the update mutation with the edited content", async () => {
    const mutateAsync = vi.fn().mockResolvedValue({ status: "saved", hash: "sha256:new" });
    await renderPage({
      ...sampleEntity,
      rev: "rev-1",
      attributes: { content: "# Note\nbody" },
    } as unknown as typeof sampleEntity);
    vi.mocked(hooks.useUpdateMemory).mockReturnValue({
      mutate: vi.fn(),
      mutateAsync,
      isPending: false,
      reset: vi.fn(),
    } as unknown as ReturnType<typeof hooks.useUpdateMemory>);

    // Re-render with the mutation mock in place
    await act(async () => {
      screen.getByTestId("edit-button").click();
    });
    expect(screen.getByTestId("doc-editor")).toBeInTheDocument();

    await act(async () => {
      screen.getByTestId("mock-save").click();
    });
    // Commit step shows the diff of old vs edited
    const diff = screen.getByTestId("pierre-diff");
    expect(diff.textContent).toContain("edited line");

    await act(async () => {
      screen.getByRole("button", { name: "Commit" }).click();
    });
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "owner",
        type: "User",
        prior: "rev-1",
        attributes: expect.objectContaining({ content: "# Note\nbody\nedited line" }),
      })
    );
  });

  it("keep editing returns to the editor with the draft", async () => {
    await renderPage({
      ...sampleEntity,
      rev: "rev-1",
      attributes: { content: "# Note\nbody" },
    } as unknown as typeof sampleEntity);
    await act(async () => {
      screen.getByTestId("edit-button").click();
    });
    await act(async () => {
      screen.getByTestId("mock-save").click();
    });
    await act(async () => {
      screen.getByRole("button", { name: "Keep editing" }).click();
    });
    expect(screen.getByTestId("doc-editor")).toBeInTheDocument();
  });

  it("entities without prose get the properties editor", async () => {
    await renderPage({ ...sampleEntity, rev: "rev-1" });
    await act(async () => {
      screen.getByTestId("edit-button").click();
    });
    expect(screen.getByTestId("properties-editor")).toBeInTheDocument();
  });
});
