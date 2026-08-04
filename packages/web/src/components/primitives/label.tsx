import { type LabelHTMLAttributes, forwardRef } from "react";
import { cn } from "~/lib/cn";

export const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(
  function Label({ className, ...rest }, ref) {
    return (
      // biome-ignore lint/a11y/noLabelWithoutControl: Label is a composable primitive; consumers supply htmlFor.
      <label
        ref={ref}
        className={cn("text-xs font-medium text-muted tracking-wide", className)}
        {...rest}
      />
    );
  }
);
