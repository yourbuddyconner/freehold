import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusChip } from "./StatusChip";

describe("StatusChip", () => {
  it.each([
    ["approved", "Approved"],
    ["held", "Held"],
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

  it("is always a link (href required)", () => {
    render(<StatusChip status="held" href="/proposals/abc123" />);
    const chip = screen.getByRole("link");
    expect(chip).toHaveAttribute("href", "/proposals/abc123");
  });

  it("approved chip has approved-palette class reference", () => {
    const { container } = render(<StatusChip status="approved" href="/e" />);
    const el = container.firstChild as HTMLElement;
    // Check it applies the status-approved color via class
    expect(el.className).toContain("status-approved");
  });

  it("held chip has held-palette class reference", () => {
    const { container } = render(<StatusChip status="held" href="/e" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("status-held");
  });
});
