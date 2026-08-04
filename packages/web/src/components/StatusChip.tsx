import { cn } from "~/lib/cn";

export type StatusKind = "approved" | "pending" | "degraded" | "rejected";

const STATUS_CLASSES: Record<StatusKind, string> = {
  approved:
    "bg-[var(--color-status-approved-bg)] text-[var(--color-status-approved)] border-[var(--color-status-approved)]",
  pending: "bg-[var(--color-status-pending-bg)] text-[var(--color-status-pending)] border-[var(--color-status-pending)]",
  degraded:
    "bg-[var(--color-status-degraded-bg)] text-[var(--color-status-degraded)] border-[var(--color-status-degraded)]",
  rejected:
    "bg-[var(--color-status-rejected-bg)] text-[var(--color-status-rejected)] border-[var(--color-status-rejected)]",
};

const STATUS_LABELS: Record<StatusKind, string> = {
  approved: "Approved",
  pending: "Pending",
  degraded: "Degraded",
  rejected: "Rejected",
};

interface StatusChipProps {
  status: StatusKind;
  /** Link to the decision record, failing check, or rule. When omitted, renders as a non-interactive span. */
  href?: string;
  label?: string;
  className?: string;
}

export function StatusChip({ status, href, label, className }: StatusChipProps) {
  const classes = cn(
    "inline-flex items-center border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide no-underline transition-opacity hover:opacity-80",
    STATUS_CLASSES[status],
    className
  );
  const content = label ?? STATUS_LABELS[status];
  if (href) {
    return (
      <a href={href} className={classes}>
        {content}
      </a>
    );
  }
  return <span className={classes}>{content}</span>;
}
