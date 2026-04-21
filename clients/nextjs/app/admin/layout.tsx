"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { authClient } from "@/lib/auth-client";

const NAV = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/agents", label: "Agents" },
  { href: "/admin/activity", label: "Activity" },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { data: session, isPending } = authClient.useSession();

  if (isPending) return <div className="p-8 text-sm text-zinc-300">Loading…</div>;
  if (!session) {
    return (
      <div className="p-8 text-sm text-zinc-300">
        Sign in at <Link href="/" className="underline">/</Link> before opening admin pages.
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800/80 bg-zinc-950/80 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Workspace admin</p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight">Control plane</h1>
          </div>
          <div className="flex items-center gap-2">
            <details className="group relative">
              <summary className="list-none cursor-pointer rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800">
                Admin pages ▾
              </summary>
              <div className="absolute right-0 z-20 mt-2 min-w-48 rounded-lg border border-zinc-800 bg-zinc-950 p-1 shadow-lg shadow-black/50">
                {NAV.map((item) => {
                  const active =
                    item.href === "/admin"
                      ? pathname === "/admin"
                      : pathname?.startsWith(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`block rounded-md px-3 py-2 text-xs transition ${
                        active
                          ? "bg-emerald-500/20 text-emerald-200"
                          : "text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100"
                      }`}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </details>
            <Link
              href="/"
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800"
            >
              ← Back to workspace
            </Link>
          </div>
        </div>
        <nav className="mt-4 flex gap-2 text-xs">
          {NAV.filter((item) => item.href !== "/admin").map((item) => {
            const active = pathname?.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-md px-3 py-1.5 transition ${
                  active
                    ? "bg-emerald-500/20 text-emerald-200"
                    : "border border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-700 hover:text-zinc-100"
                }`}
              >
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
