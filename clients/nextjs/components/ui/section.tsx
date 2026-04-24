"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export function CollapsibleSection({
  title,
  icon,
  children,
  defaultOpen = true,
  badge,
  className,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  badge?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={cn("", className)}>
      <div className="flex w-full items-center gap-2 px-1 py-1.5">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 text-left"
        >
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 text-zinc-500 transition-transform duration-200",
              !open && "-rotate-90",
            )}
          />
          {icon && <span className="text-zinc-400">{icon}</span>}
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
            {title}
          </span>
        </button>
        {badge}
      </div>
      {open && <div className="mt-1">{children}</div>}
    </div>
  );
}
