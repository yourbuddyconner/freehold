import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProvenanceFooter } from "./ProvenanceFooter";

// Mock clipboard API using vi.stubGlobal so userEvent doesn't fight it.
const mockWriteText = vi.fn(() => Promise.resolve());
vi.stubGlobal("navigator", {
  ...navigator,
  clipboard: { writeText: mockWriteText },
});

describe("ProvenanceFooter", () => {
  const props = {
    author: "claude-code",
    method: "model-assisted",
    approvalLabel: "Approved",
    changesetHash: "abc123def456789",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders author chip", () => {
    render(<ProvenanceFooter {...props} />);
    expect(screen.getByTestId("provenance-author")).toHaveTextContent("claude-code");
  });

  it("renders method chip", () => {
    render(<ProvenanceFooter {...props} />);
    expect(screen.getByTestId("provenance-method")).toHaveTextContent("model-assisted");
  });

  it("renders approval badge", () => {
    render(<ProvenanceFooter {...props} />);
    expect(screen.getByTestId("provenance-approval")).toHaveTextContent("Approved");
  });

  it("renders held status with amber palette class when approvalStatus=held", () => {
    render(<ProvenanceFooter {...props} approvalLabel="Held" approvalStatus="held" />);
    const badge = screen.getByTestId("provenance-approval");
    expect(badge).toHaveTextContent("Held");
    // StatusChip must apply the held palette class
    const chip = badge.firstElementChild as HTMLElement;
    expect(chip?.className).toContain("status-held");
  });

  it("renders rejected status with red palette class when approvalStatus=rejected", () => {
    render(<ProvenanceFooter {...props} approvalLabel="Rejected" approvalStatus="rejected" />);
    const badge = screen.getByTestId("provenance-approval");
    expect(badge).toHaveTextContent("Rejected");
    const chip = badge.firstElementChild as HTMLElement;
    expect(chip?.className).toContain("status-rejected");
  });

  it("renders approved status with approved palette class when approvalStatus=approved", () => {
    render(
      <ProvenanceFooter
        {...props}
        approvalLabel="Approved"
        approvalStatus="approved"
        evidenceHref="/evidence/abc"
      />
    );
    const badge = screen.getByTestId("provenance-approval");
    const chip = badge.firstElementChild as HTMLElement;
    expect(chip?.className).toContain("status-approved");
    // When evidenceHref is set, StatusChip renders as an <a>
    expect(chip?.tagName).toBe("A");
  });

  it("renders truncated hash", () => {
    render(<ProvenanceFooter {...props} />);
    const hashEl = screen.getByTestId("provenance-hash");
    expect(hashEl).toHaveTextContent("abc123def456…");
  });

  it("copies full hash on click", async () => {
    render(<ProvenanceFooter {...props} />);
    const hashEl = screen.getByTestId("provenance-hash");
    await act(async () => {
      fireEvent.click(hashEl);
    });
    expect(mockWriteText).toHaveBeenCalledWith("abc123def456789");
  });

  it("shows Copied! feedback after click", async () => {
    render(<ProvenanceFooter {...props} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("provenance-hash"));
    });
    expect(screen.getByTestId("provenance-hash")).toHaveTextContent("Copied!");
  });
});
