"use client";

/**
 * GenuiPartView — renders a `ui` message part.
 *
 * Accepts the raw `payload` from a `{ type: "ui", payload: { spec, catalog } }`
 * message part and renders it using `@json-render/react`'s `Renderer` with the
 * genuiRegistry.
 *
 * If the spec is invalid or a component is unknown, a safe fallback is shown
 * instead of throwing — this keeps the message thread usable even if an agent
 * posts a malformed spec.
 */

import { Renderer, JSONUIProvider } from "@json-render/react";
import type { Spec } from "@json-render/react";
import { genuiRegistry } from "./registry";

// ── types ─────────────────────────────────────────────────────────────────────

type GenuiPayload = {
  spec?: Spec;
  catalog?: string;
  version?: string;
  [key: string]: unknown;
};

type Props = {
  payload: GenuiPayload;
};

// ── component ─────────────────────────────────────────────────────────────────

export function GenuiPartView({ payload }: Props) {
  const spec = payload.spec;

  if (!spec || typeof spec !== "object" || !("root" in spec) || !("elements" in spec)) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-400">
        <span className="font-semibold text-zinc-300">ui</span>
        {" — "}
        <span>invalid or empty spec</span>
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-3"
      data-testid="genui-part"
      data-catalog={payload.catalog ?? "unknown"}
    >
      <ErrorBoundaryRenderer spec={spec as Spec} />
    </div>
  );
}

// ── error boundary wrapper ────────────────────────────────────────────────────

import { Component, type ReactNode } from "react";

type EBState = { error: string | null };

class ErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, EBState> {
  state: EBState = { error: null };
  static getDerivedStateFromError(e: unknown): EBState {
    return { error: e instanceof Error ? e.message : "render error" };
  }
  render() {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div className="rounded border border-red-900/40 bg-red-950/20 px-3 py-2 text-xs text-red-300">
            Render error: {this.state.error}
          </div>
        )
      );
    }
    return this.props.children;
  }
}

function ErrorBoundaryRenderer({ spec }: { spec: Spec }) {
  return (
    <ErrorBoundary>
      <JSONUIProvider registry={genuiRegistry}>
        <Renderer spec={spec} registry={genuiRegistry} />
      </JSONUIProvider>
    </ErrorBoundary>
  );
}
