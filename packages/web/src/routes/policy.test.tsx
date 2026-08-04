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
}));

vi.mock("~/lib/api", () => ({
  apiClient: {
    proposals: vi.fn(),
    approve: vi.fn().mockResolvedValue({}),
    reject: vi.fn().mockResolvedValue({}),
    recall: vi.fn(),
    getEntity: vi.fn(),
    schema: vi.fn(),
    getPolicy: vi.fn(),
    log: vi.fn(),
    principals: vi.fn(),
    proposePolicy: vi.fn().mockResolvedValue({}),
    registerAgent: vi.fn().mockResolvedValue({}),
    installOntology: vi.fn().mockResolvedValue({}),
    verify: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

const policyFixture = {
  rules: [
    {
      id: "require-attribution",
      title: "Require attribution",
      selector: "entity.*",
      require: "agent != 'anonymous'",
    },
    {
      id: "no-pii",
      title: "No PII without consent",
      selector: "entity.Preference",
      require: "consent == true",
    },
  ],
};

function setupHooks(policyData: unknown = policyFixture) {
  vi.mocked(hooks.usePolicy).mockReturnValue({
    data: policyData,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.usePolicy>);

  vi.mocked(hooks.usePending).mockReturnValue({
    data: { proposals: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.usePending>);

  vi.mocked(hooks.useSchema).mockReturnValue({
    data: { entityTypes: [], edgeTypes: [], terms: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useSchema>);

  vi.mocked(hooks.useRecall).mockReturnValue({
    data: { results: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useRecall>);

  vi.mocked(hooks.useVerify).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useVerify>);

  vi.mocked(hooks.useEntity).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useEntity>);

  vi.mocked(hooks.useLog).mockReturnValue({
    data: { entries: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useLog>);

  vi.mocked(hooks.usePrincipals).mockReturnValue({
    data: { principals: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.usePrincipals>);
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
  });

  it("renders rule cards with plain title and mono block", async () => {
    await renderPolicy();
    expect(screen.getAllByTestId("rule-title")[0]).toHaveTextContent("Require attribution");
    expect(screen.getAllByTestId("rule-title")[1]).toHaveTextContent("No PII without consent");
  });

  it("shows selector and require in mono block", async () => {
    await renderPolicy();
    expect(screen.getAllByTestId("rule-selector")[0]).toHaveTextContent("entity.*");
    expect(screen.getAllByTestId("rule-require")[0]).toHaveTextContent("agent != 'anonymous'");
  });

  it("shows empty state when no rules", async () => {
    await renderPolicy({ rules: [] });
    expect(screen.getByText(/no policy rules loaded/i)).toBeInTheDocument();
  });

  it("opens edit drawer when Edit button is clicked", async () => {
    await renderPolicy();
    const editButtons = screen.getAllByTestId("edit-rule-require-attribution");
    await act(async () => {
      fireEvent.click(editButtons[0]);
    });
    // Drawer should be visible
    expect(screen.getByLabelText("Policy YAML")).toBeInTheDocument();
  });

  it("submit button disabled when YAML unchanged", async () => {
    await renderPolicy();
    const editBtn = screen.getByTestId("edit-rule-require-attribution");
    await act(async () => {
      fireEvent.click(editBtn);
    });
    const submitBtn = screen.getByTestId("submit-policy");
    expect(submitBtn).toBeDisabled();
  });

  it("submit button enabled after editing YAML", async () => {
    await renderPolicy();
    const editBtn = screen.getByTestId("edit-rule-require-attribution");
    await act(async () => {
      fireEvent.click(editBtn);
    });
    const textarea = screen.getByLabelText("Policy YAML");
    await act(async () => {
      fireEvent.change(textarea, {
        target: { value: "rules:\n  - id: changed\n    title: Changed" },
      });
    });
    const submitBtn = screen.getByTestId("submit-policy");
    expect(submitBtn).not.toBeDisabled();
  });

  it("submitting creates a proposal and routes to inbox", async () => {
    await renderPolicy();
    const editBtn = screen.getByTestId("edit-rule-require-attribution");
    await act(async () => {
      fireEvent.click(editBtn);
    });
    const textarea = screen.getByLabelText("Policy YAML");
    await act(async () => {
      fireEvent.change(textarea, {
        target: { value: "rules:\n  - id: changed\n    title: Changed" },
      });
    });
    const submitBtn = screen.getByTestId("submit-policy");
    await act(async () => {
      fireEvent.click(submitBtn);
    });
    await waitFor(() => {
      expect(vi.mocked(apiClient.proposePolicy)).toHaveBeenCalled();
    });
  });

  it("diff preview appears when YAML is changed", async () => {
    await renderPolicy();
    const editBtn = screen.getByTestId("edit-rule-require-attribution");
    await act(async () => {
      fireEvent.click(editBtn);
    });
    const textarea = screen.getByLabelText("Policy YAML");
    await act(async () => {
      fireEvent.change(textarea, {
        target: { value: "rules:\n  - id: changed\n    title: Changed" },
      });
    });
    const diffToggle = screen.getByRole("button", { name: /show diff preview/i });
    expect(diffToggle).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(diffToggle);
    });
    expect(screen.getByText(/Before → After/)).toBeInTheDocument();
  });
});
