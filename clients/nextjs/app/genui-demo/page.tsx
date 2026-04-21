/**
 * /genui-demo — Generative UI showcase page.
 *
 * A standalone page (no auth required) that demonstrates every component in
 * the genui catalog rendered from static json-render specs.  Useful for:
 *
 *   - Visual QA during development
 *   - agent-browser smoke tests
 *   - Demoing the feature to teammates
 *
 * Access at http://localhost:3001/genui-demo
 */

import { GenuiPartView } from "@/components/genui/genui-part-view";

// ── sample specs ──────────────────────────────────────────────────────────────

const sprintDashboardSpec = {
  root: "card-1",
  elements: {
    "card-1": {
      type: "Card",
      props: { title: "Sprint 42 — Dashboard", description: "14-day sprint, ending Friday" },
      children: ["metrics-stack"],
    },
    "metrics-stack": {
      type: "Stack",
      props: { direction: "horizontal", gap: 4, wrap: true },
      children: ["m-prs", "m-issues", "m-coverage"],
    },
    "m-prs": {
      type: "Metric",
      props: { label: "PRs merged", value: "17", trend: "up", description: "↑3 vs last sprint" },
      children: [],
    },
    "m-issues": {
      type: "Metric",
      props: { label: "Issues closed", value: "23", description: "of 28 planned" },
      children: [],
    },
    "m-coverage": {
      type: "Metric",
      props: { label: "Test coverage", value: "94%", trend: "up" },
      children: [],
    },
  },
};

const statusTableSpec = {
  root: "stack-1",
  elements: {
    "stack-1": {
      type: "Stack",
      props: { direction: "vertical", gap: 3 },
      children: ["heading-1", "table-1"],
    },
    "heading-1": {
      type: "Heading",
      props: { level: 3, text: "Agent Activity" },
      children: [],
    },
    "table-1": {
      type: "Table",
      props: { caption: "Last 24 hours" },
      children: ["row-head", "row-1", "row-2", "row-3"],
    },
    "row-head": {
      type: "TableRow",
      props: {},
      children: ["th-agent", "th-action", "th-status"],
    },
    "row-1": {
      type: "TableRow",
      props: {},
      children: ["td-a1", "td-action1", "td-s1"],
    },
    "row-2": {
      type: "TableRow",
      props: {},
      children: ["td-a2", "td-action2", "td-s2"],
    },
    "row-3": {
      type: "TableRow",
      props: {},
      children: ["td-a3", "td-action3", "td-s3"],
    },
    "th-agent": { type: "TableCell", props: { text: "Agent", header: true }, children: [] },
    "th-action": { type: "TableCell", props: { text: "Action", header: true }, children: [] },
    "th-status": { type: "TableCell", props: { text: "Status", header: true }, children: [] },
    "td-a1": { type: "TableCell", props: { text: "coder-bot" }, children: [] },
    "td-action1": { type: "TableCell", props: { text: "Opened PR #142" }, children: [] },
    "td-s1": { type: "TableCell", props: { text: "✓ Merged" }, children: [] },
    "td-a2": { type: "TableCell", props: { text: "release-app" }, children: [] },
    "td-action2": { type: "TableCell", props: { text: "Published v1.2.0" }, children: [] },
    "td-s2": { type: "TableCell", props: { text: "✓ Done" }, children: [] },
    "td-a3": { type: "TableCell", props: { text: "coder-bot" }, children: [] },
    "td-action3": { type: "TableCell", props: { text: "Running tests" }, children: [] },
    "td-s3": { type: "TableCell", props: { text: "⏳ In progress" }, children: [] },
  },
};

const alertsSpec = {
  root: "stack-alerts",
  elements: {
    "stack-alerts": {
      type: "Stack",
      props: { direction: "vertical", gap: 3 },
      children: ["heading-alerts", "alert-success", "alert-warning", "alert-error", "alert-info"],
    },
    "heading-alerts": {
      type: "Heading",
      props: { level: 3, text: "Alert variants" },
      children: [],
    },
    "alert-success": {
      type: "Alert",
      props: { variant: "success", title: "Deployment succeeded", message: "v1.2.0 is live in production." },
      children: [],
    },
    "alert-warning": {
      type: "Alert",
      props: { variant: "warning", title: "Coverage dropped", message: "Test coverage fell below 90% on the auth module." },
      children: [],
    },
    "alert-error": {
      type: "Alert",
      props: { variant: "error", title: "Build failed", message: "The CI pipeline failed on step 'type-check'." },
      children: [],
    },
    "alert-info": {
      type: "Alert",
      props: { variant: "info", message: "Agent requested permission to create a new channel." },
      children: [],
    },
  },
};

const progressSpec = {
  root: "card-progress",
  elements: {
    "card-progress": {
      type: "Card",
      props: { title: "Release checklist" },
      children: ["stack-progress"],
    },
    "stack-progress": {
      type: "Stack",
      props: { direction: "vertical", gap: 3 },
      children: ["p1", "p2", "p3", "sep", "badge-done"],
    },
    "p1": {
      type: "Progress",
      props: { value: 100, label: "Unit tests", showPercent: true },
      children: [],
    },
    "p2": {
      type: "Progress",
      props: { value: 67, label: "E2E tests", showPercent: true },
      children: [],
    },
    "p3": {
      type: "Progress",
      props: { value: 20, label: "Documentation", showPercent: true },
      children: [],
    },
    "sep": {
      type: "Separator",
      props: {},
      children: [],
    },
    "badge-done": {
      type: "Badge",
      props: { text: "2/3 complete", variant: "warning" },
      children: [],
    },
  },
};

const listSpec = {
  root: "card-list",
  elements: {
    "card-list": {
      type: "Card",
      props: { title: "Next steps" },
      children: ["list-1"],
    },
    "list-1": {
      type: "List",
      props: { ordered: true },
      children: ["li-1", "li-2", "li-3"],
    },
    "li-1": { type: "ListItem", props: { text: "Merge feature/auth-refactor branch" }, children: [] },
    "li-2": { type: "ListItem", props: { text: "Update staging environment" }, children: [] },
    "li-3": { type: "ListItem", props: { text: "Tag release v1.3.0 and publish" }, children: [] },
  },
};

const codeSpec = {
  root: "card-code",
  elements: {
    "card-code": {
      type: "Card",
      props: { title: "Generated migration" },
      children: ["code-1"],
    },
    "code-1": {
      type: "Code",
      props: {
        language: "sql",
        content: `ALTER TABLE users
  ADD COLUMN last_login_at TIMESTAMPTZ;

CREATE INDEX idx_users_last_login
  ON users (last_login_at DESC);`,
      },
      children: [],
    },
  },
};

const buttonsSpec = {
  root: "card-btns",
  elements: {
    "card-btns": {
      type: "Card",
      props: { title: "Actions" },
      children: ["btn-stack"],
    },
    "btn-stack": {
      type: "Stack",
      props: { direction: "horizontal", gap: 2, wrap: true },
      children: ["btn-default", "btn-outline", "btn-ghost", "btn-destructive", "btn-link"],
    },
    "btn-default": {
      type: "Button",
      props: { label: "Deploy now", variant: "default" },
      children: [],
    },
    "btn-outline": {
      type: "Button",
      props: { label: "Preview", variant: "outline" },
      children: [],
    },
    "btn-ghost": {
      type: "Button",
      props: { label: "Dismiss", variant: "ghost" },
      children: [],
    },
    "btn-destructive": {
      type: "Button",
      props: { label: "Rollback", variant: "destructive" },
      children: [],
    },
    "btn-link": {
      type: "Button",
      props: { label: "Open PR #142", variant: "outline", href: "https://github.com" },
      children: [],
    },
  },
};

// ── page ──────────────────────────────────────────────────────────────────────

const demos = [
  { id: "sprint-dashboard", label: "Sprint Dashboard", spec: sprintDashboardSpec },
  { id: "status-table", label: "Status Table", spec: statusTableSpec },
  { id: "alerts", label: "Alert Variants", spec: alertsSpec },
  { id: "progress", label: "Progress Bars", spec: progressSpec },
  { id: "list", label: "Ordered List", spec: listSpec },
  { id: "code", label: "Code Block", spec: codeSpec },
  { id: "buttons", label: "Button Variants", spec: buttonsSpec },
];

export default function GenuiDemoPage() {
  return (
    <div className="min-h-screen bg-zinc-950 px-6 py-8 text-zinc-100">
      <header className="mb-8 border-b border-zinc-800 pb-6">
        <div className="flex items-center gap-3">
          <span className="rounded-lg border border-emerald-700/60 bg-emerald-900/20 px-2.5 py-1 text-xs font-semibold text-emerald-300">
            genui
          </span>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="page-heading">
            Generative UI Demo
          </h1>
        </div>
        <p className="mt-2 text-sm text-zinc-400">
          Agents post <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs">ui</code> message
          parts containing json-render specs. This page shows every component in the catalog.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {demos.map((d) => (
            <a
              key={d.id}
              href={`#${d.id}`}
              className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200"
            >
              {d.label}
            </a>
          ))}
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-8">
        {demos.map((demo) => (
          <section key={demo.id} id={demo.id}>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">
              {demo.label}
            </h2>
            {/* Simulate how the MessageCard renders a ui part */}
            <GenuiPartView payload={{ catalog: "shadcn", spec: demo.spec }} />

            {/* Show the spec source for reference */}
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-zinc-600 hover:text-zinc-400">
                View spec JSON
              </summary>
              <pre className="mt-2 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-[10px] leading-relaxed text-zinc-500">
                {JSON.stringify(demo.spec, null, 2)}
              </pre>
            </details>
          </section>
        ))}
      </main>

      <footer className="mt-12 border-t border-zinc-800 pt-6 text-center text-xs text-zinc-600">
        message-layer · genui catalog · powered by{" "}
        <a
          href="https://github.com/vercel-labs/json-render"
          className="text-zinc-500 hover:text-zinc-300"
          target="_blank"
          rel="noreferrer"
        >
          json-render
        </a>
      </footer>
    </div>
  );
}
