import { type HTMLAttributes, forwardRef } from "react";
import { cn } from "~/lib/cn";

type Variant = "neutral" | "accent" | "success" | "danger";

const VARIANT: Record<Variant, string> = {
  neutral: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  accent: "bg-blue-100 text-blue-700 dark:bg-blue-700/30 dark:text-blue-100",
  success: "bg-green-500/15 text-green-700 dark:text-green-400",
  danger: "bg-red-500/15 text-red-700 dark:text-red-400",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, variant = "neutral", ...rest },
  ref
) {
  return (
    <span
      ref={ref}
      className={cn(
        "inline-flex items-center rounded-sm px-1.5 py-0.5 text-[11px] font-medium tracking-wide",
        VARIANT[variant],
        className
      )}
      {...rest}
    />
  );
});
