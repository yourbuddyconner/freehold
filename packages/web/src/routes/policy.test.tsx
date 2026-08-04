import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "~/lib/api";
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
    getPolicy: vi.fn(),
    proposePolicy: vi.fn(),
  },
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

  it("edits a rule inline and proposes the changed policy", async () => {
    await renderPolicy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("edit-rule-scratch-is-free"));
    });
    const textarea = screen.getByLabelText("Edit rule scratch-is-free") as HTMLTextAreaElement;
    expect(textarea.value).toContain("scratch-is-free");

    const edited = JSON.parse(textarea.value);
    edited.require = { reviewers: { quorum: 1, role: "owner" } };
    await act(async () => {
      fireEvent.change(textarea, { target: { value: JSON.stringify(edited, null, 2) } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("save-rule-scratch-is-free"));
    });

    await waitFor(() => {
      expect(apiClient.proposePolicy).toHaveBeenCalledTimes(1);
    });
    const arg = vi.mocked(apiClient.proposePolicy).mock.calls[0][0] as { policy_yaml: string };
    const proposed = JSON.parse(arg.policy_yaml);
    expect(proposed.default_posture).toBe("restricted");
    const rule = proposed.rules.find((r: { name: string }) => r.name === "scratch-is-free");
    expect(rule.require).toEqual({ reviewers: { quorum: 1, role: "owner" } });
    // Pending banner links to the Inbox
    expect(screen.getByText(/pending in the/i)).toBeInTheDocument();
  });

  it("disables propose while the draft is invalid JSON", async () => {
    await renderPolicy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("edit-rule-scratch-is-free"));
    });
    const textarea = screen.getByLabelText("Edit rule scratch-is-free");
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "{ not json" } });
    });
    expect(screen.getByTestId("save-rule-scratch-is-free")).toBeDisabled();
    expect(screen.getByText(/not valid json yet/i)).toBeInTheDocument();
  });
});
