"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, XCircle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastVariant = "success" | "error" | "info";

type ToastItem = {
  id: number;
  message: string;
  variant: ToastVariant;
};

let toastId = 0;
const listeners: Array<(toast: ToastItem) => void> = [];

export function toast(message: string, variant: ToastVariant = "info") {
  const item: ToastItem = { id: ++toastId, message, variant };
  for (const fn of listeners) fn(item);
}

toast.success = (message: string) => toast(message, "success");
toast.error = (message: string) => toast(message, "error");

const icons: Record<ToastVariant, ReactNode> = {
  success: <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
  error: <XCircle className="h-4 w-4 text-red-400" />,
  info: <Info className="h-4 w-4 text-sky-400" />,
};

const styles: Record<ToastVariant, string> = {
  success: "border-emerald-500/20 bg-emerald-500/5",
  error: "border-red-500/20 bg-red-500/5",
  info: "border-sky-500/20 bg-sky-500/5",
};

export function Toaster() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const handler = (t: ToastItem) => {
      setToasts((prev) => [...prev, t]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((item) => item.id !== t.id));
      }, 4000);
    };
    listeners.push(handler);
    return () => {
      const idx = listeners.indexOf(handler);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "flex items-center gap-2.5 rounded-lg border px-4 py-2.5 text-sm text-zinc-200 shadow-lg shadow-black/30 backdrop-blur-sm transition-all",
            styles[t.variant],
          )}
        >
          {icons[t.variant]}
          <span className="max-w-xs">{t.message}</span>
          <button
            type="button"
            onClick={() =>
              setToasts((prev) => prev.filter((item) => item.id !== t.id))
            }
            className="ml-2 text-zinc-500 hover:text-zinc-300"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
