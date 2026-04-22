import { cn } from "@/lib/utils";

type AvatarSize = "sm" | "md" | "lg";

const sizeStyles: Record<AvatarSize, string> = {
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-xs",
  lg: "h-10 w-10 text-sm",
};

const typeColors: Record<string, string> = {
  human: "bg-sky-500/20 text-sky-300",
  agent: "bg-emerald-500/20 text-emerald-300",
  app: "bg-indigo-500/20 text-indigo-300",
  default: "bg-zinc-700 text-zinc-300",
};

export interface AvatarProps {
  name: string;
  type?: string;
  size?: AvatarSize;
  className?: string;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function Avatar({ name, type = "default", size = "md", className }: AvatarProps) {
  const color = typeColors[type] ?? typeColors.default;
  return (
    <div
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold",
        color,
        sizeStyles[size],
        className,
      )}
      title={name}
    >
      {getInitials(name)}
    </div>
  );
}
