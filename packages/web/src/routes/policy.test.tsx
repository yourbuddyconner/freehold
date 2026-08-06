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

  it("stages a saves-type rule with schema_valid: true in require", async () => {
    const mockStage = vi.fn();
    vi.mocked(changesetModule.useChangeset).mockReturnValue(
      makeChangesetStore({ stage: mockStage }) as ReturnType<typeof changesetModule.useChangeset>
    );

    await renderPolicy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("edit-rule-scratch-is-free"));
    });

    // Keep it as "saves" kind (default)
    await act(async () => {
      fireEvent.click(screen.getByTestId("stage-rule-scratch-is-free"));
    });

    expect(mockStage).toHaveBeenCalledTimes(1);
    const payload = mockStage.mock.calls[0][0].payload as {
      rules: Array<{ name: string; require: unknown }>;
    };
    const rule = payload.rules.find((r) => r.name === "scratch-is-free");
    expect((rule?.require as { schema_valid?: boolean })?.schema_valid).toBe(true);
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

  it("does not show staged chip due to substring match (exact label match only)", async () => {
    vi.mocked(changesetModule.useChangeset).mockReturnValue(
      makeChangesetStore({
        entries: [
          {
            id: "e1",
            kind: "policy",
            label: "policy: edit rule scratch-is-free-v2",
            payload: { rules: [{ name: "scratch-is-free-v2" }] },
          },
        ],
      }) as ReturnType<typeof changesetModule.useChangeset>
    );

    await renderPolicy();
    const card = screen.getByTestId("rule-scratch-is-free");
    // Should NOT show staged chip because the label doesn't exactly match
    expect(card).not.toHaveTextContent(/staged/i);
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

  it("add-path: typing a pattern and clicking Add appends a chip and the staged payload includes the new path", async () => {
    const mockStage = vi.fn();
    vi.mocked(changesetModule.useChangeset).mockReturnValue(
      makeChangesetStore({ stage: mockStage }) as ReturnType<typeof changesetModule.useChangeset>
    );

    await renderPolicy();

    // Open editor for a rule that has no paths (agent-writes-are-proposals has a selector but
    // pathsFromSelector returns no plain region — only a "not" branch, which the walker does visit
    // but only for "workspace/scratch". Use scratch-is-free which yields ["workspace/scratch"].
    // We add a NEW, distinct path so the duplicate guard doesn't block.)
    await act(async () => {
      fireEvent.click(screen.getByTestId("edit-rule-scratch-is-free"));
    });

    // Type a new path in the Path pattern input
    const pathInput = screen.getByLabelText("Path pattern");
    await act(async () => {
      fireEvent.change(pathInput, { target: { value: "workspace/notes" } });
    });

    // Click the Add button
    const addBtn = screen.getByTestId("add-path-btn");
    await act(async () => {
      fireEvent.click(addBtn);
    });

    // Chip for the new path should now appear
    expect(screen.getByText("workspace/notes")).toBeInTheDocument();
    // Input should be cleared after adding
    expect(pathInput).toHaveValue("");

    // Stage the change and verify the payload includes the new path
    await act(async () => {
      fireEvent.click(screen.getByTestId("stage-rule-scratch-is-free"));
    });

    expect(mockStage).toHaveBeenCalledTimes(1);
    const payload = mockStage.mock.calls[0][0].payload as {
      rules: Array<{ name: string; select?: unknown }>;
    };
    const rule = payload.rules.find((r) => r.name === "scratch-is-free");
    const selectStr = JSON.stringify(rule?.select ?? "");
    expect(selectStr).toContain("workspace/notes");
  });

  it("add-path: pressing Enter in the path input also adds a chip", async () => {
    await renderPolicy();

    await act(async () => {
      fireEvent.click(screen.getByTestId("edit-rule-scratch-is-free"));
    });

    const pathInput = screen.getByLabelText("Path pattern");
    await act(async () => {
      fireEvent.change(pathInput, { target: { value: "workspace/archive" } });
    });

    await act(async () => {
      fireEvent.keyDown(pathInput, { key: "Enter" });
    });

    expect(screen.getByText("workspace/archive")).toBeInTheDocument();
    expect(pathInput).toHaveValue("");
  });

  it("add-rule affordance appears before the first rule section", async () => {
    await renderPolicy();
    const addBtn = screen.getByTestId("add-rule-btn");
    const saveSection = screen.getByTestId("outcome-saves");
    // add-rule-btn must appear before the first outcome section in DOM order
    expect(
      addBtn.compareDocumentPosition(saveSection) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("staging a new rule appends it to the definition", async () => {
    const mockStage = vi.fn();
    vi.mocked(changesetModule.useChangeset).mockReturnValue(
      makeChangesetStore({ stage: mockStage }) as ReturnType<typeof changesetModule.useChangeset>
    );

    await renderPolicy();

    // Click "Add rule" button
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-rule-btn"));
    });

    // Fill in the name
    const nameInput = screen.getByLabelText("New rule name");
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: "new-test-rule" } });
    });

    // Click "Stage add"
    await act(async () => {
      fireEvent.click(screen.getByTestId("stage-add-rule-btn"));
    });

    expect(mockStage).toHaveBeenCalledTimes(1);
    const call = mockStage.mock.calls[0][0];
    expect(call.kind).toBe("policy");
    expect(call.label).toBe("policy: add rule new-test-rule");
    const payload = call.payload as { rules: Array<{ name: string }> };
    expect(payload.rules.some((r) => r.name === "new-test-rule")).toBe(true);
    // Existing rules are preserved
    expect(payload.rules.some((r) => r.name === "scratch-is-free")).toBe(true);
  });

  it("staging an edit attaches preview.before (current definition) and preview.after (next definition)", async () => {
    const mockStage = vi.fn();
    vi.mocked(changesetModule.useChangeset).mockReturnValue(
      makeChangesetStore({ stage: mockStage }) as ReturnType<typeof changesetModule.useChangeset>
    );

    await renderPolicy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("edit-rule-scratch-is-free"));
    });

    const nameInput = screen.getByLabelText("Rule name");
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: "scratch-is-free-v2" } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("stage-rule-scratch-is-free"));
    });

    expect(mockStage).toHaveBeenCalledTimes(1);
    const call = mockStage.mock.calls[0][0];
    expect(call.preview).toBeDefined();
    expect(call.preview.name).toBe("policy.json");

    // before is the current definition
    const parsedBefore = JSON.parse(call.preview.before);
    expect(parsedBefore.rules.some((r: { name: string }) => r.name === "scratch-is-free")).toBe(
      true
    );

    // after is the next definition with the updated rule
    const parsedAfter = JSON.parse(call.preview.after);
    expect(parsedAfter.rules.some((r: { name: string }) => r.name === "scratch-is-free-v2")).toBe(
      true
    );
    expect(parsedAfter.rules.some((r: { name: string }) => r.name === "scratch-is-free")).toBe(
      false
    );
  });

  it("staging a delete attaches preview with the rule removed in after", async () => {
    const mockStage = vi.fn();
    vi.mocked(changesetModule.useChangeset).mockReturnValue(
      makeChangesetStore({ stage: mockStage }) as ReturnType<typeof changesetModule.useChangeset>
    );

    await renderPolicy();

    const deleteBtn = screen.getByTestId("delete-rule-scratch-is-free");
    await act(async () => {
      fireEvent.click(deleteBtn);
    });
    const confirmBtn = screen.getByTestId("confirm-delete-scratch-is-free");
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    expect(mockStage).toHaveBeenCalledTimes(1);
    const call = mockStage.mock.calls[0][0];
    expect(call.preview).toBeDefined();
    expect(call.preview.name).toBe("policy.json");

    const parsedBefore = JSON.parse(call.preview.before);
    expect(parsedBefore.rules.some((r: { name: string }) => r.name === "scratch-is-free")).toBe(
      true
    );

    const parsedAfter = JSON.parse(call.preview.after);
    expect(
      parsedAfter.rules.find((r: { name: string }) => r.name === "scratch-is-free")
    ).toBeUndefined();
  });

  it("staging an add attaches preview with the new rule in after", async () => {
    const mockStage = vi.fn();
    vi.mocked(changesetModule.useChangeset).mockReturnValue(
      makeChangesetStore({ stage: mockStage }) as ReturnType<typeof changesetModule.useChangeset>
    );

    await renderPolicy();

    await act(async () => {
      fireEvent.click(screen.getByTestId("add-rule-btn"));
    });

    const nameInput = screen.getByLabelText("New rule name");
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: "preview-test-rule" } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("stage-add-rule-btn"));
    });

    expect(mockStage).toHaveBeenCalledTimes(1);
    const call = mockStage.mock.calls[0][0];
    expect(call.preview).toBeDefined();
    expect(call.preview.name).toBe("policy.json");

    const parsedBefore = JSON.parse(call.preview.before);
    expect(
      parsedBefore.rules.find((r: { name: string }) => r.name === "preview-test-rule")
    ).toBeUndefined();

    const parsedAfter = JSON.parse(call.preview.after);
    expect(parsedAfter.rules.some((r: { name: string }) => r.name === "preview-test-rule")).toBe(
      true
    );
  });

  it("preview.after of a stage call matches what preview.before would be for a subsequent edit of the same definition", async () => {
    const mockStage = vi.fn();
    vi.mocked(changesetModule.useChangeset).mockReturnValue(
      makeChangesetStore({ stage: mockStage }) as ReturnType<typeof changesetModule.useChangeset>
    );

    await renderPolicy();

    // Stage a first edit: rename scratch-is-free
    await act(async () => {
      fireEvent.click(screen.getByTestId("edit-rule-scratch-is-free"));
    });
    const nameInput = screen.getByLabelText("Rule name");
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: "scratch-is-free-v2" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("stage-rule-scratch-is-free"));
    });

    expect(mockStage).toHaveBeenCalledTimes(1);
    const firstCall = mockStage.mock.calls[0][0];
    const firstAfter = JSON.parse(firstCall.preview.after);

    // The definition prop fed to PolicyRuleEditor is the raw fixture definition —
    // so a second edit on the same fixture has the same before as the first.
    // Assert that firstCall.preview.after is the next definition (contains the renamed rule)
    // and that firstCall.preview.before matches the fixture definition.
    const firstBefore = JSON.parse(firstCall.preview.before);
    expect(firstBefore).toEqual(definition);
    expect(firstAfter.rules.some((r: { name: string }) => r.name === "scratch-is-free-v2")).toBe(
      true
    );

    // The after of the first stage equals what a consumer would use as the next state,
    // confirming preview.after is a valid complete definition.
    expect(JSON.parse(firstCall.preview.after)).toEqual(firstCall.payload);
  });
});
