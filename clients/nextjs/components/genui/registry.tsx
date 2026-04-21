"use client";

/**
 * Generative UI component registry — shadcn-style implementations.
 *
 * Each component is built with Tailwind CSS classes that match the dark-mode
 * design system used across the Next.js client.  No Radix UI dependency so
 * there are no peer-dependency conflicts with Tailwind v4.
 *
 * The registry is created via `defineRegistry(catalog, { components })` from
 * `@json-render/react`.  Each component receives typed `props` and a `children`
 * ReactNode (already rendered by the Renderer).
 */

import type { ReactNode } from "react";
import { defineRegistry } from "@json-render/react";
import { genuiCatalog } from "./catalog";

// ── type helpers ──────────────────────────────────────────────────────────────

type RenderProps<T extends Record<string, unknown>> = {
  props: T;
  children?: ReactNode;
  emit?: (action: string, data?: Record<string, unknown>) => void;
};

// ── colour maps ───────────────────────────────────────────────────────────────

const variantBorder: Record<string, string> = {
  default: "border-zinc-700",
  success: "border-emerald-700/60",
  warning: "border-amber-700/60",
  error: "border-red-800/60",
  info: "border-sky-700/60",
};
const variantBg: Record<string, string> = {
  default: "bg-zinc-900/60",
  success: "bg-emerald-950/30",
  warning: "bg-amber-950/30",
  error: "bg-red-950/30",
  info: "bg-sky-950/30",
};
const variantText: Record<string, string> = {
  default: "text-zinc-100",
  success: "text-emerald-200",
  warning: "text-amber-200",
  error: "text-red-200",
  info: "text-sky-200",
};
const variantBadgeBg: Record<string, string> = {
  default: "bg-zinc-800 text-zinc-300",
  success: "bg-emerald-900/50 text-emerald-300",
  warning: "bg-amber-900/50 text-amber-300",
  error: "bg-red-900/50 text-red-300",
  info: "bg-sky-900/50 text-sky-300",
};

// ── component implementations ─────────────────────────────────────────────────

const components = {
  // ── Layout ──

  Stack({ props, children }: RenderProps<{ direction?: string; gap?: number | string; align?: string; wrap?: boolean }>) {
    const isHorizontal = props.direction === "horizontal";
    const gap = props.gap !== undefined ? `gap-${props.gap}` : "gap-3";
    const align = props.align === "center" ? "items-center" : props.align === "end" ? "items-end" : "items-start";
    const wrap = props.wrap ? "flex-wrap" : "";
    return (
      <div className={`flex ${isHorizontal ? "flex-row" : "flex-col"} ${gap} ${align} ${wrap}`}>
        {children}
      </div>
    );
  },

  Card({ props, children }: RenderProps<{ title?: string; description?: string; footer?: string }>) {
    return (
      <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/60 p-4">
        {props.title && (
          <h3 className="mb-1 text-sm font-semibold text-zinc-100">{props.title}</h3>
        )}
        {props.description && (
          <p className="mb-3 text-xs text-zinc-400">{props.description}</p>
        )}
        <div className={props.title ? "mt-3" : ""}>{children}</div>
        {props.footer && (
          <p className="mt-3 border-t border-zinc-800 pt-3 text-xs text-zinc-500">{props.footer}</p>
        )}
      </div>
    );
  },

  Separator({ props }: RenderProps<{ orientation?: string; label?: string }>) {
    if (props.label) {
      return (
        <div className="flex items-center gap-3">
          <div className="flex-1 border-t border-zinc-800" />
          <span className="text-[10px] uppercase tracking-widest text-zinc-500">{props.label}</span>
          <div className="flex-1 border-t border-zinc-800" />
        </div>
      );
    }
    return (
      <div className={props.orientation === "vertical" ? "h-full w-px bg-zinc-800" : "border-t border-zinc-800"} />
    );
  },

  // ── Typography ──

  Heading({ props }: RenderProps<{ level?: number; text: string }>) {
    const level = props.level ?? 2;
    const sizes: Record<number, string> = {
      1: "text-2xl font-bold text-zinc-50",
      2: "text-xl font-semibold text-zinc-100",
      3: "text-base font-semibold text-zinc-200",
      4: "text-sm font-semibold text-zinc-300",
    };
    const cls = sizes[level] ?? sizes[2];
    if (level === 1) return <h1 className={cls}>{props.text}</h1>;
    if (level === 3) return <h3 className={cls}>{props.text}</h3>;
    if (level === 4) return <h4 className={cls}>{props.text}</h4>;
    return <h2 className={cls}>{props.text}</h2>;
  },

  Text({ props }: RenderProps<{ text: string; muted?: boolean; bold?: boolean; size?: string }>) {
    const size = { xs: "text-xs", sm: "text-sm", base: "text-sm", lg: "text-base" }[props.size ?? "sm"] ?? "text-sm";
    const colour = props.muted ? "text-zinc-400" : "text-zinc-200";
    const weight = props.bold ? "font-semibold" : "";
    return <p className={`${size} ${colour} ${weight} leading-relaxed`}>{props.text}</p>;
  },

  // ── Data display ──

  Badge({ props }: RenderProps<{ text: string; variant?: string }>) {
    const v = props.variant ?? "default";
    return (
      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium ${variantBadgeBg[v] ?? variantBadgeBg.default}`}>
        {props.text}
      </span>
    );
  },

  Alert({ props }: RenderProps<{ title?: string; message: string; variant?: string }>) {
    const v = props.variant ?? "default";
    const icon: Record<string, string> = { success: "✓", warning: "⚠", error: "✗", info: "ℹ", default: "•" };
    return (
      <div className={`rounded-lg border px-3 py-2.5 ${variantBorder[v] ?? variantBorder.default} ${variantBg[v] ?? variantBg.default} ${variantText[v] ?? variantText.default}`}>
        {props.title && (
          <p className="flex items-center gap-1.5 text-xs font-semibold">
            <span>{icon[v] ?? "•"}</span>
            {props.title}
          </p>
        )}
        <p className={`text-xs leading-relaxed ${props.title ? "mt-1 opacity-90" : ""}`}>{props.message}</p>
      </div>
    );
  },

  Metric({ props }: RenderProps<{ label: string; value: string; description?: string; trend?: string }>) {
    const trendColour = props.trend === "up" ? "text-emerald-400" : props.trend === "down" ? "text-red-400" : "text-zinc-500";
    const trendIcon = props.trend === "up" ? "↑" : props.trend === "down" ? "↓" : "";
    return (
      <div className="min-w-[100px] rounded-lg border border-zinc-800 bg-zinc-900/80 p-3">
        <p className="text-[10px] uppercase tracking-widest text-zinc-500">{props.label}</p>
        <p className="mt-1 text-2xl font-bold tabular-nums text-zinc-100">
          {props.value}
          {trendIcon && <span className={`ml-1 text-base ${trendColour}`}>{trendIcon}</span>}
        </p>
        {props.description && (
          <p className="mt-0.5 text-[11px] text-zinc-500">{props.description}</p>
        )}
      </div>
    );
  },

  Progress({ props }: RenderProps<{ value: number; label?: string; showPercent?: boolean }>) {
    const pct = Math.max(0, Math.min(100, props.value));
    return (
      <div className="space-y-1">
        {(props.label || props.showPercent) && (
          <div className="flex items-center justify-between text-xs text-zinc-400">
            {props.label && <span>{props.label}</span>}
            {props.showPercent && <span>{pct}%</span>}
          </div>
        )}
        <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    );
  },

  // ── Tables ──

  Table({ props, children }: RenderProps<{ caption?: string }>) {
    return (
      <div className="overflow-hidden rounded-lg border border-zinc-800">
        <table className="w-full text-xs">
          {props.caption && (
            <caption className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-left text-[10px] uppercase tracking-widest text-zinc-500">
              {props.caption}
            </caption>
          )}
          <tbody>{children}</tbody>
        </table>
      </div>
    );
  },

  TableRow({ children }: RenderProps<Record<never, never>>) {
    return (
      <tr className="border-b border-zinc-800/60 last:border-0 even:bg-zinc-900/30">
        {children}
      </tr>
    );
  },

  TableCell({ props }: RenderProps<{ text?: string; header?: boolean; align?: string }>) {
    const align = props.align === "center" ? "text-center" : props.align === "right" ? "text-right" : "text-left";
    const cls = `px-3 py-2 ${align}`;
    if (props.header) {
      return (
        <th className={`${cls} bg-zinc-900/70 text-[10px] uppercase tracking-widest text-zinc-400`}>
          {props.text}
        </th>
      );
    }
    return <td className={`${cls} text-zinc-200`}>{props.text}</td>;
  },

  // ── Actions ──

  Button({ props, emit }: RenderProps<{ label: string; variant?: string; href?: string; disabled?: boolean }>) {
    const base = "inline-flex items-center rounded-lg px-3 py-1.5 text-xs font-medium transition";
    const variants: Record<string, string> = {
      default: "bg-zinc-100 text-zinc-900 hover:bg-white",
      outline: "border border-zinc-600 text-zinc-200 hover:border-zinc-400 hover:bg-zinc-800/60",
      ghost: "text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100",
      destructive: "bg-red-600/80 text-white hover:bg-red-500",
    };
    const cls = `${base} ${variants[props.variant ?? "default"] ?? variants.default} ${props.disabled ? "pointer-events-none opacity-50" : ""}`;

    if (props.href) {
      return (
        <a href={props.href} className={cls} target="_blank" rel="noreferrer">
          {props.label}
        </a>
      );
    }
    return (
      <button
        type="button"
        className={cls}
        disabled={props.disabled}
        onClick={() => emit?.("press", {})}
      >
        {props.label}
      </button>
    );
  },

  // ── Forms (display mode) ──

  Input({ props }: RenderProps<{ label?: string; placeholder?: string; value?: string; type?: string; readOnly?: boolean }>) {
    return (
      <div className="space-y-1">
        {props.label && (
          <label className="block text-[11px] font-medium text-zinc-400">{props.label}</label>
        )}
        <input
          type={props.type ?? "text"}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900/80 px-3 py-1.5 text-xs text-zinc-200 outline-none"
          placeholder={props.placeholder}
          defaultValue={props.value}
          readOnly={props.readOnly !== false}
        />
      </div>
    );
  },

  Checkbox({ props }: RenderProps<{ label: string; checked?: boolean; readOnly?: boolean }>) {
    return (
      <label className="flex cursor-default items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          className="accent-emerald-500"
          defaultChecked={props.checked}
          readOnly={props.readOnly !== false}
        />
        {props.label}
      </label>
    );
  },

  // ── Lists ──

  List({ props, children }: RenderProps<{ ordered?: boolean }>) {
    const cls = "space-y-1 pl-4 text-xs text-zinc-300";
    if (props.ordered) {
      return <ol className={`${cls} list-decimal`}>{children}</ol>;
    }
    return <ul className={`${cls} list-disc`}>{children}</ul>;
  },

  ListItem({ props }: RenderProps<{ text: string }>) {
    return <li className="leading-relaxed">{props.text}</li>;
  },

  // ── Code ──

  Code({ props }: RenderProps<{ content: string; language?: string }>) {
    return (
      <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
        {props.language && (
          <div className="border-b border-zinc-800 px-3 py-1 text-[10px] uppercase tracking-widest text-zinc-500">
            {props.language}
          </div>
        )}
        <pre className="overflow-x-auto p-3 text-[11px] leading-relaxed text-zinc-300">
          {props.content}
        </pre>
      </div>
    );
  },
};

// ── registry ──────────────────────────────────────────────────────────────────

export const { registry: genuiRegistry } = defineRegistry(genuiCatalog, {
  components,
  actions: {
    navigate: async () => {},
    copy: async () => {},
  },
});
