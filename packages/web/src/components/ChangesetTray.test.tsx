import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "~/lib/api";
import { ChangesetProvider, useChangeset } from "~/lib/changeset";
import { ChangesetTray } from "./ChangesetTray";

vi.mock("~/lib/api", () => ({
  apiClient: {
    proposePolicy: vi.fn(),
  },
}));

const GRAPH_ID = "g1";
const store = new Map<string, string>();

function renderTray(initialEntries?: { kind: string; label: string; payload: unknown }[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  // We need to pre-populate the changeset before render.
  // Achieve this by wrapping in a helper component that stages on mount.
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <ChangesetProvider graphId={GRAPH_ID}>{children}</ChangesetProvider>
      </QueryClientProvider>
    );
  }

  const { rerender } = render(
    <Wrapper>
      <ChangesetTray />
    </Wrapper>
  );

  return { qc, rerender, Wrapper };
}

// Helper to stage entries via the context before rendering the tray.
function renderTrayWithEntries(entries: Array<{ kind: string; label: string; payload: unknown }>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  // Use a wrapper component that exposes stage via a test button
  function TestHarness() {
    const { stage } = useChangeset();
    return (
      <button
        type="button"
        data-testid="stage-btn"
        onClick={() => {
          for (const e of entries) stage(e);
        }}
      >
        stage
      </button>
    );
  }

  render(
    <QueryClientProvider client={qc}>
      <ChangesetProvider graphId={GRAPH_ID}>
        <TestHarness />
        <ChangesetTray />
      </ChangesetProvider>
    </QueryClientProvider>
  );

  // Stage all entries
  act(() => {
    fireEvent.click(screen.getByTestId("stage-btn"));
  });

  return { qc };
}

describe("ChangesetTray", () => {
  beforeEach(() => {
    store.clear();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, String(v)),
        removeItem: (k: string) => store.delete(k),
        clear: () => store.clear(),
      },
    });
    vi.clearAllMocks();
    vi.mocked(apiClient.proposePolicy).mockResolvedValue({ status: "pending", hash: "sha:abc" });
  });

  it("renders nothing when no entries are staged", () => {
    renderTray();
    expect(screen.queryByTestId("changeset-tray")).not.toBeInTheDocument();
  });

  it("shows each staged entry label", () => {
    renderTrayWithEntries([
      { kind: "policy", label: "policy: edit rule foo", payload: { rules: [] } },
      { kind: "policy", label: "policy: delete rule bar", payload: { rules: [] } },
    ]);
    expect(screen.getByTestId("changeset-tray")).toBeInTheDocument();
    expect(screen.getByText("policy: edit rule foo")).toBeInTheDocument();
    expect(screen.getByText("policy: delete rule bar")).toBeInTheDocument();
  });

  it("unstages an entry when its remove button is clicked", () => {
    renderTrayWithEntries([
      { kind: "policy", label: "policy: edit rule foo", payload: { rules: [] } },
    ]);
    const removeBtn = screen.getByTestId("unstage-0");
    act(() => {
      fireEvent.click(removeBtn);
    });
    expect(screen.queryByTestId("changeset-tray")).not.toBeInTheDocument();
  });

  it("Commit button posts the final policy payload and shows success", async () => {
    const finalDef = { policy: "x", version: 1, rules: [{ name: "last" }] };
    renderTrayWithEntries([
      {
        kind: "policy",
        label: "policy: edit rule a",
        payload: { policy: "x", version: 1, rules: [{ name: "first" }] },
      },
      { kind: "policy", label: "policy: edit rule b", payload: finalDef },
    ]);

    const commitBtn = screen.getByTestId("commit-btn");
    await act(async () => {
      fireEvent.click(commitBtn);
    });

    await waitFor(() => {
      expect(apiClient.proposePolicy).toHaveBeenCalledTimes(1);
    });

    const arg = vi.mocked(apiClient.proposePolicy).mock.calls[0][0] as { policy_yaml: string };
    const submitted = JSON.parse(arg.policy_yaml);
    // The LAST policy entry's payload wins
    expect(submitted.rules[0].name).toBe("last");

    // Tray clears on success
    await waitFor(() => {
      expect(screen.queryByTestId("changeset-tray")).not.toBeInTheDocument();
    });
  });

  it("Cancel button clears the tray", () => {
    renderTrayWithEntries([
      { kind: "policy", label: "policy: edit rule foo", payload: { rules: [] } },
    ]);
    act(() => {
      fireEvent.click(screen.getByTestId("cancel-btn"));
    });
    expect(screen.queryByTestId("changeset-tray")).not.toBeInTheDocument();
  });

  it("does not call proposePolicy if no policy entries are staged", async () => {
    // Stage a non-policy entry — tray should show but commit is a no-op
    renderTrayWithEntries([{ kind: "other", label: "some other thing", payload: null }]);
    const commitBtn = screen.getByTestId("commit-btn");
    await act(async () => {
      fireEvent.click(commitBtn);
    });
    expect(apiClient.proposePolicy).not.toHaveBeenCalled();
  });

  it("shows success banner after successful commit", async () => {
    renderTrayWithEntries([
      { kind: "policy", label: "policy: edit rule foo", payload: { rules: [] } },
    ]);

    const commitBtn = screen.getByTestId("commit-btn");
    await act(async () => {
      fireEvent.click(commitBtn);
    });

    // Success banner should appear
    await waitFor(() => {
      expect(screen.getByTestId("changeset-success")).toBeInTheDocument();
      expect(screen.getByText("Proposal submitted.")).toBeInTheDocument();
    });

    // Original tray should not be visible (entries cleared)
    expect(screen.queryByTestId("changeset-tray")).not.toBeInTheDocument();
  });
});
