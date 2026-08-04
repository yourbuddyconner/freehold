import { cn } from "~/lib/cn";

export type StatusKind = "approved" | "held" | "degraded" | "rejected";

const STATUS_CLASSES: Record<StatusKind, string> = {
  approved:
    "bg-[var(--color-status-approved-bg)] text-[var(--color-status-approved)] border-[var(--color-status-approved)]",
  held: "bg-[var(--color-status-held-bg)] text-[var(--color-status-held)] border-[var(--color-status-held)]",
  degraded:
    "bg-[var(--color-status-degraded-bg)] text-[var(--color-status-degraded)] border-[var(--color-status-degraded)]",
  rejected:
    "bg-[var(--color-status-rejected-bg)] text-[var(--color-status-rejected)] border-[var(--color-status-rejected)]",
};

const STATUS_LABELS: Record<StatusKind, string> = {
  approved: "Approved",
  held: "Held",
  degraded: "Degraded",
  rejected: "Rejected",
};

interface StatusChipProps {
  status: StatusKind;
  /** Link to the decision record, failing check, or rule — required per design. */
  href: string;
  label?: string;
  className?: string;
}

export function StatusChip({ status, href, label, className }: StatusChipProps) {
  return (
    <a
      href={href}
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium tracking-wide no-underline transition-opacity hover:opacity-80",
        STATUS_CLASSES[status],
        className
      )}
    >
      {label ?? STATUS_LABELS[status]}
    </a>
  );
}
