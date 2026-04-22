# Message-Layer

> message-layer is a **headless messaging and coordination layer for humans, agents, and apps**

It is:

- a **structured communication substrate**
- a **permissioned coordination layer**
- a **source of truth for interactions**

## Philosophy

### 1. Messages are the center

Everything is built around messages.

- actions happen through messages
- permissions relate to messages
- knowledge is derived from messages
- audit logs reference message activity

Do not bypass messages with hidden systems.

---

## 2. Minimal core, everything else is a plugin

The core should stay small and stable.

Core owns:

- orgs
- actors
- channels
- threads
- messages
- permissions
- privacy
- audit

Everything else:

- memory
- search
- analytics
- file storage
- notifications

→ must be plugins

---

## 3. One system, multiple modes

The same system must work in:

- local mode (PGlite)
- hosted mode (Postgres + Better Auth)
- embedded mode (external auth)

Do not create separate architectures.

---

## 4. No direct DB access

All interactions go through the system:

- HTTP API
- WebSocket subscriptions

Agents and apps must NOT talk directly to the database.

This preserves:

- permissions
- audit
- events
- consistency

---

## 5. Permission-first design

Never fail silently.

If an action is denied:

→ convert it into a **PermissionRequest** when possible

Flow:

- attempt
- deny
- request
- approve / reject
- grant
- retry

Permissions are:

- scoped
- time-bounded
- purpose-aware

---

## 6. Privacy is a hard boundary

Privacy applies everywhere:

- channels
- threads
- messages
- artifacts
- knowledge
- discovery
- notifications

Rule:

> derived data must never be more visible than its source unless explicitly promoted

Never leak data across scopes.

---

## 7. Structured messages (parts)

Messages are not just text.

They contain typed parts:

- text
- tool_call
- tool_result
- artifact
- approval_request
- approval_response

Agents must use structured parts, not encode everything as text.

---

## 8. Actors are unified

Everything is an actor:

- human
- agent
- app

They share the same system:

- same permissions
- same message model
- same audit

Differences are behavioral, not structural.

---

## 9. Audit everything important

Audit is first-class.

Every meaningful action must be traceable:

- who did it
- what they did
- where
- when
- why (if available)

Audit logs must be:

- append-only
- tamper-evident capable
- exportable

---

## 10. Local-first developer experience

The system must run locally with:

- no Docker required
- PGlite as DB
- local file storage
- full functionality

Tests must run locally without mocks.

---

## 11. No mocking of core systems

Core flows must be tested with real implementations:

- real DB (PGlite)
- real server
- real WebSockets
- real permission checks

Mocks are only acceptable for:

- external services (optional plugins)

---

## 12. Event-driven, not tightly coupled

Core emits events.

Plugins consume events.

Core must not depend on plugins.

---

## 14. File storage is external

Files are not stored in message rows.

Core stores:

- metadata
- references

Storage is delegated to:

- S3
- R2
- MinIO
- local FS

---

## 15. Memory is derived, not primary

Memory is:

- derived from messages
- scoped by privacy
- stored separately
- queryable

Memory must:

- respect source scope
- support promotion explicitly

---

## 16. Consistency over cleverness

Prefer:

- simple flows
- explicit state
- clear ownership

Avoid:

- hidden magic
- implicit behavior
- over-abstraction

---

# Key Flows (must work)

1. Human + agent + app in a channel
2. Channel → thread workflow
3. Permission request lifecycle
4. Cross-device sync via cursor + WS
5. Agent acting on behalf of human
6. Private scope isolation
7. File artifact lifecycle
8. Message → knowledge derivation
9. Realtime subscription + replay
10. Full audit trace of a workflow

If these do not feel clean, the design is wrong.

---

# Architecture Rules

## Transport

- WebSockets for realtime
- HTTP for commands
- transport must be swappable

## Storage

- Postgres = canonical
- PGlite = local
- append-only where possible

## Auth

- pluggable
- normalized principal
- do not own identity unnecessarily

## Plugins

- consume events
- do not mutate core state directly
- must respect permissions and privacy

---

# What to Avoid

- turning this into a Slack clone
- embedding business logic into core
- coupling plugins to core logic
- leaking private data into global systems
- relying on mocks for correctness
- overbuilding v1

---

## Mental Model

Think of message-layer as:

> a **git-like log of interactions**, with permissions, identity, and realtime access

or

> a **message-based API layer for humans, agents, and apps**

---

# Decision Heuristics

When unsure, choose the option that:

1. keeps core smaller
2. preserves message-centric design
3. enforces permissions explicitly
4. respects privacy boundaries
5. works in local-first mode
6. is testable without mocks
7. does not assume a specific plugin

---

# Final Principle

> If it cannot be expressed as messages, permissions, and events — it probably does not belong in the core.

## Documentation Guidelines

Agent-specific guidance for this repository:

- Use `docs/` for full API reference docs. Current spec lives in
  [`docs/spec/`](./docs/spec/).
- Keep `README.md` focused on a condensed, developer-facing overview only.
- Use [`CONTRIBUTING.md`](./CONTRIBUTING.md) for local development workflow
  instructions — project layout, commands, test strategy, and conventions.
- In `AGENTS.md`, reference `CONTRIBUTING.md` and build on top of it for
  agent workflows.

## Agent workflow notes

Before editing code, read `CONTRIBUTING.md` for the project layout and the
"no mocks" test rule. When in doubt:

- All state transitions go through `src/service.ts`.
- Every state transition emits a `DomainEvent` on the shared `EventBus`.
- Privacy + permission checks live in the service, never in HTTP handlers.
- WebSocket and HTTP are both transports on top of the same service; adding
  a new capability means one service function, one HTTP route, optionally
  one WS message, and corresponding unit + e2e tests.
- Plugins never mutate core state; they subscribe to the bus and/or mount
  additional HTTP routes.

## Change Workflow

If we're changing the implementation or reverting something, remove all the old code including docs and tests. Never mark a feature as "legacy" and try to keep it around to be backwards compatible.
