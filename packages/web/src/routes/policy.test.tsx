import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "~/lib/api";
import * as changesetModule from "~/lib/changeset";
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
  useProposePolicy: vi.fn().mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("~/lib/api", () => ({
  GRAPH_STORAGE_KEY: "freehold-graph",
  setActiveGraph: vi.fn(),
  apiClient: {
    proposals: vi.fn(),
    getPolicy: vi.fn(),
    proposePolicy: vi.fn(),
  },
}));

vi.mock("~/lib/changeset", () => ({
  ChangesetProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useChangeset: vi.fn(() => ({
    graphId: "test",
    entries: [],
    intent: "",
    stage: vi.fn(),
    unstage: vi.fn(),
    clear: vi.fn(),
    setIntent: vi.fn(),
  })),
}));

const definition = {
  policy: "memory-local",
  version: 1,
  default_posture: "restricted",
  roles: { owner: ["principal:owner"] },
  rules: [
    {
      name: "scratch-is-free",
      require: { schema_valid: true },
      select: { all: [{ author_kind: "agent" }, { region: "workspace/scratch" }] },
    },
    {
      name: "agent-writes-are-proposals",
      require: { reviewers: { quorum: 1, role: "owner" } },
      select: { all: [{ author_kind: "agent" }, { not: { region: "workspace/scratch" } }] },
    },
    {
      name: "model-assisted-needs-signed-envelope",
      require: { attestation_required: { attester_class: "indexer" } },
      select: { all: [{ basis: "model-assisted" }, { not: { region: "workspace/scratch" } }] },
    },
  ],
};

const policyFixture = {
  name: "memory-baseline",
  definition: JSON.stringify(definition),
  rules: definition.rules,
};

const emptyQuery = { isLoading: false, isError: false, error: null };

function setupHooks(policyData: unknown = policyFixture) {
  vi.mocked(hooks.usePolicy).mockReturnValue({
    data: policyData,
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.usePolicy>);
  vi.mocked(hooks.usePending).mockReturnValue({
    data: { proposals: [] },
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.usePending>);
  vi.mocked(hooks.useSchema).mockReturnValue({
    data: { entityTypes: [], edgeTypes: [], terms: [] },
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

function makeChangesetStore(
  overrides: { stage?: ReturnType<typeof vi.fn>; entries?: unknown[] } = {}
) {
  return {
    graphId: "test",
    entries: overrides.entries ?? [],
    intent: "",
    stage: overrides.stage ?? vi.fn(),
    unstage: vi.fn(),
    clear: vi.fn(),
    setIntent: vi.fn(),
  };
}

async function renderPolicy(policyData: unknown = policyFixture) {
  setupHooks(policyData);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/policy"] }),
  });
  await act(async () => {
    render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    );
  });
  return { qc };
}

describe("Policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.proposePolicy).mockResolvedValue({
      status: "pending",
      hash: "sha256:abc",
    } as never);
    vi.mocked(changesetModule.useChangeset).mockReturnValue(
      makeChangesetStore() as ReturnType<typeof changesetModule.useChangeset>
    );
  });

  it("shows the decision summary, roles, and the everything-else posture", async () => {
    await renderPolicy();
    const summary = screen.getByTestId("policy-summary");
    expect(summary).toHaveTextContent(/every write is checked against every rule/i);
    expect(summary).toHaveTextContent("owner = owner");
    const fallback = screen.getByTestId("outcome-default");
    expect(fallback).toHaveTextContent(/goes to your Inbox and waits/i);
    expect(fallback).toHaveTextContent("restricted");
  });

  it("groups rules under outcome sections", async () => {
    await renderPolicy();
    expect(screen.getByTestId("outcome-saves")).toHaveTextContent("Saves without you");
    expect(screen.getByTestId("outcome-saves")).toHaveTextContent("scratch-is-free");
    expect(screen.getByTestId("outcome-review")).toHaveTextContent("Waits in your Inbox");
    expect(screen.getByTestId("outcome-review")).toHaveTextContent("agent-writes-are-proposals");
    expect(screen.getByTestId("outcome-attestation")).toHaveTextContent(
      "Needs cryptographic proof"
    );
  });

  it("renders each rule in plain language with its outcome chip", async () => {
    await renderPolicy();
    const scratch = screen.getByTestId("rule-scratch-is-free");
    expect(scratch).toHaveTextContent(
      /When an agent wrote it and it is classified in the workspace\/scratch region/
    );
    expect(scratch).toHaveTextContent(/saves on the spot/i);
    expect(scratch).toHaveTextContent("Saves instantly");

    const proposals = screen.getByTestId("rule-agent-writes-are-proposals");
    expect(proposals).toHaveTextContent(/outside the workspace\/scratch region/);
    expect(proposals).toHaveTextContent(/stays pending until you approve it/i);
    expect(proposals).toHaveTextContent("Goes to Inbox");

    const envelope = screen.getByTestId("rule-model-assisted-needs-signed-envelope");
    expect(envelope).toHaveTextContent(/signed envelope from the indexer/i);
  });

  it("drills down into the raw definition", async () => {
    await renderPolicy();
    const scratch = screen.getByTestId("rule-scratch-is-free");
    const toggle = scratch.querySelector('[aria-expanded="false"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(scratch).toHaveTextContent('"schema_valid": true');
  });

  it("shows empty state when no rules", async () => {
    await renderPolicy({ name: "x", definition: JSON.stringify({ rules: [] }), rules: [] });
    expect(screen.getByText(/no policy rules loaded/i)).toBeInTheDocument();
  });

  it("stages a rule edit without calling proposePolicy directly", async () => {
    const mockStage = vi.fn();
    vi.mocked(changesetModule.useChangeset).mockReturnValue(
      makeChangesetStore({ stage: mockStage }) as ReturnType<typeof changesetModule.useChangeset>
    );

    await renderPolicy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("edit-rule-scratch-is-free"));
    });

    // Change the require via dropdown
    const requireSelect = screen.getByRole("combobox");
    await act(async () => {
      fireEvent.change(requireSelect, { target: { value: "review" } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("stage-rule-scratch-is-free"));
    });

    expect(mockStage).toHaveBeenCalledTimes(1);
    expect(apiClient.proposePolicy).not.toHaveBeenCalled();
    const payload = mockStage.mock.calls[0][0].payload as {
      default_posture: string;
      rules: Array<{ name: string; require: unknown }>;
    };
    expect(payload.default_posture).toBe("restricted");
    const rule = payload.rules.find((r) => r.name === "scratch-is-free");
    expect((rule?.require as { reviewers?: unknown })?.reviewers).toBeDefined();
  });

  it("disables Stage change button when rule name is empty", async () => {
    await renderPolicy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("edit-rule-scratch-is-free"));
    });
    const nameInput = screen.getByLabelText("Rule name");
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: "" } });
    });
    expect(screen.getByTestId("stage-rule-scratch-is-free")).toBeDisabled();
  });
});

describe("Policy structured editor + staging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(changesetModule.useChangeset).mockReturnValue(
      makeChangesetStore() as ReturnType<typeof changesetModule.useChangeset>
    );
    vi.mocked(apiClient.proposePolicy).mockResolvedValue({
      status: "pending",
      hash: "sha256:abc",
    } as never);
  });

  it("shows 'Stage change' button instead of 'Propose change' on each rule card", async () => {
    await renderPolicy();
    // Should have Stage change buttons, not Propose change
    expect(screen.queryByText(/propose change/i)).not.toBeInTheDocument();
    // After clicking Edit, should see Stage change
    await act(async () => {
      fireEvent.click(screen.getByTestId("edit-rule-scratch-is-free"));
    });
    expect(screen.getByTestId("stage-rule-scratch-is-free")).toBeInTheDocument();
  });

  it("staging a rule edit calls useChangeset.stage with the full definition payload", async () => {
    const mockStage = vi.fn();
    vi.mocked(changesetModule.useChangeset).mockReturnValue(
      makeChangesetStore({ stage: mockStage }) as ReturnType<typeof changesetModule.useChangeset>
    );

    await renderPolicy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("edit-rule-scratch-is-free"));
    });

    // Change the name field
    const nameInput = screen.getByLabelText("Rule name");
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: "scratch-is-free-v2" } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("stage-rule-scratch-is-free"));
    });

    expect(mockStage).toHaveBeenCalledTimes(1);
    const call = mockStage.mock.calls[0][0];
    expect(call.kind).toBe("policy");
    expect(call.label).toContain("policy: edit rule");
    // Payload is the full definition with updated rule
    const payload = call.payload as { rules: Array<{ name: string }> };
    expect(payload.rules.some((r) => r.name === "scratch-is-free-v2")).toBe(true);
    // No direct API call
    expect(apiClient.proposePolicy).not.toHaveBeenCalled();
  });

  it("shows staged chip on a rule card when it is staged", async () => {
    vi.mocked(changesetModule.useChangeset).mockReturnValue(
      makeChangesetStore({
        entries: [
          {
            id: "e1",
            kind: "policy",
            label: "policy: edit rule scratch-is-free",
            payload: { rules: [{ name: "scratch-is-free" }] },
          },
        ],
      }) as ReturnType<typeof changesetModule.useChangeset>
    );

    await renderPolicy();
    const card = screen.getByTestId("rule-scratch-is-free");
    expect(card).toHaveTextContent(/staged/i);
  });

  it("delete rule stages a definition without that rule", async () => {
    const mockStage = vi.fn();
    vi.mocked(changesetModule.useChangeset).mockReturnValue(
      makeChangesetStore({ stage: mockStage }) as ReturnType<typeof changesetModule.useChangeset>
    );

    await renderPolicy();
    // Click Delete on scratch-is-free
    const deleteBtn = screen.getByTestId("delete-rule-scratch-is-free");
    await act(async () => {
      fireEvent.click(deleteBtn);
    });
    // Confirm inline
    const confirmBtn = screen.getByTestId("confirm-delete-scratch-is-free");
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    expect(mockStage).toHaveBeenCalledTimes(1);
    const payload = mockStage.mock.calls[0][0].payload as { rules: Array<{ name: string }> };
    expect(payload.rules.find((r) => r.name === "scratch-is-free")).toBeUndefined();
    expect(apiClient.proposePolicy).not.toHaveBeenCalled();
  });
});
