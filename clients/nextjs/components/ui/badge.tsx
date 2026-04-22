import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "secondary" | "outline" | "emerald" | "sky" | "amber" | "red" | "indigo";

const variantStyles: Record<Variant, string> = {
  default: "bg-zinc-800 text-zinc-300",
  secondary: "bg-zinc-800/60 text-zinc-400",
  outline: "border border-zinc-700 text-zinc-300",
  emerald: "bg-emerald-500/15 text-emerald-300 border border-emerald-500/20",
  sky: "bg-sky-500/15 text-sky-300 border border-sky-500/20",
  amber: "bg-amber-500/15 text-amber-300 border border-amber-500/20",
  red: "bg-red-500/15 text-red-300 border border-red-500/20",
  indigo: "bg-indigo-500/15 text-indigo-300 border border-indigo-500/20",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
}

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors",
        variantStyles[variant],
        className,
      )}
      {...props}
    />
  );
}
