"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Bot, Activity, ChevronLeft, LayoutDashboard } from "lucide-react";
import { cn } from "@/lib/utils";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

const NAV = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard },
  { href: "/admin/agents", label: "Agents", icon: Bot },
  { href: "/admin/activity", label: "Activity", icon: Activity },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { data: session, isPending } = authClient.useSession();

  if (isPending) return <div className="p-8 text-sm text-zinc-400">Loading…</div>;
  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-zinc-400">
        Sign in at <Link href="/" className="ml-1 text-emerald-400 underline">/</Link> before opening admin pages.
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="border-b border-zinc-800/60 bg-zinc-950/80 px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="flex items-center gap-1 text-xs text-zinc-500 transition hover:text-zinc-300"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Workspace
            </Link>
            <Separator orientation="vertical" className="h-4" />
            <div>
              <h1 className="text-sm font-semibold tracking-tight">Admin</h1>
            </div>
          </div>
        </div>
        <nav className="mt-3 flex gap-1">
          {NAV.filter((item) => item.href !== "/admin").map((item) => {
            const active = pathname?.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition",
                  active
                    ? "bg-emerald-500/10 text-emerald-300"
                    : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="flex-1 overflow-y-auto px-6 py-6">{children}</main>
    </div>
  );
}
