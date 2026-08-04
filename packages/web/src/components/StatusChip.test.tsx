import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusChip } from "./StatusChip";

describe("StatusChip", () => {
  it.each([
    ["approved", "Approved"],
    ["pending", "Pending"],
    ["degraded", "Degraded"],
    ["rejected", "Rejected"],
  ] as const)("renders %s status", (status, label) => {
    render(<StatusChip status={status} href={`/evidence/${status}`} />);
    const chip = screen.getByRole("link", { name: label });
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveAttribute("href", `/evidence/${status}`);
  });

  it("uses custom label when provided", () => {
    render(<StatusChip status="approved" href="/evidence/foo" label="Verified ✓" />);
    expect(screen.getByRole("link", { name: "Verified ✓" })).toBeInTheDocument();
  });

  it("renders as a link when href is provided", () => {
    render(<StatusChip status="pending" href="/proposals/abc123" />);
    const chip = screen.getByRole("link");
    expect(chip).toHaveAttribute("href", "/proposals/abc123");
  });

  it("renders as a non-interactive span when href is omitted", () => {
    render(<StatusChip status="pending" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("approved chip has approved-palette class reference", () => {
    const { container } = render(<StatusChip status="approved" href="/e" />);
    const el = container.firstChild as HTMLElement;
    // Check it applies the status-approved color via class
    expect(el.className).toContain("status-approved");
  });

  it("pending chip has pending-palette class reference", () => {
    const { container } = render(<StatusChip status="pending" href="/e" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("status-pending");
  });
});
