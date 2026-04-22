import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
type Size = "default" | "sm" | "lg" | "icon";

const variantStyles: Record<Variant, string> = {
  default: "bg-emerald-600 text-white shadow-sm hover:bg-emerald-500",
  destructive: "bg-red-600/80 text-white shadow-sm hover:bg-red-600",
  outline: "border border-zinc-700 bg-transparent text-zinc-200 shadow-sm hover:bg-zinc-800 hover:text-zinc-100",
  secondary: "bg-zinc-800 text-zinc-200 shadow-sm hover:bg-zinc-700",
  ghost: "text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100",
  link: "text-emerald-400 underline-offset-4 hover:underline",
};

const sizeStyles: Record<Size, string> = {
  default: "h-9 px-4 py-2 text-sm",
  sm: "h-8 rounded-md px-3 text-xs",
  lg: "h-10 rounded-md px-6 text-sm",
  icon: "h-8 w-8",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500 disabled:pointer-events-none disabled:opacity-50",
        variantStyles[variant],
        sizeStyles[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
