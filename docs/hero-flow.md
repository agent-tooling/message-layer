# Hero flow

The AGENTS.md "must work" key flows, exercised as one cohesive developer
story:

> a developer runs message-layer locally, attaches a **human**, **agent**,
> and **app** to one channel, sees a permission request flow, uploads an
> artifact, derives **memory**, runs **cross-entity search**, and inspects
> the full audit trail.

This document describes the flow, how to run it, and how it maps onto the
principles in [`AGENTS.md`](../AGENTS.md).

## Run it

```bash
pnpm install
pnpm run demo:hero          # narrated in-process demo
pnpm run test               # full suite including `tests/e2e/hero-flow.test.ts`
```

`demo:hero` boots a real server on an ephemeral port with the `memory`,
`search`, `webhooks`, and `durable-streams` plugins, drives everything
through HTTP, and prints a colored narration. No external services, no
Docker.

## The flow

### 1. Bootstrap — one channel, three actors

Three actors all live in the same org and join a private channel `#launch`:

| Actor             | Type    | Role                                                   |
|-------------------|---------|--------------------------------------------------------|
| `Alice (admin)`   | `human` | Holds `channel:admin`, `grant:create`, `audit:read`.   |
| `coder-bot`       | `agent` | Headless agent that posts messages and uploads builds. |
| `release-app`     | `app`   | External runtime that announces completion.            |

A fourth actor (`curious-colleague`) is created but **not** added to
`#launch`. It's the test-subject for privacy enforcement throughout.

### 2. Permission request lifecycle

- The admin grants the agent `message:append` and `artifact:register` on
  the channel.
- The app tries to post without any grant → `403 PERMISSION_DENIED`.
- The app retries with `autoRequestOnDeny: true` → server opens a
  `permission_request` and returns `{ denied, requestId, capability }`.
- The admin resolves the request with `approve: true`; the service
  auto-issues a matching grant and emits `permission_request.resolved` +
  `grant.created`.
- The app retries and succeeds.

This is AGENTS.md rule #5 ("permission-first design") end to end.

### 3. Artifact upload + download

- The agent `POST /v1/artifacts` a tarball (base64-encoded in the JSON
  body). Core stores metadata in SQL and bytes through the pluggable
  blob `StorageAdapter` (local-FS by default; in-memory for the demo).
- The app `GET /v1/artifacts/:id/content` and verifies `sha256`.
- The outsider tries the same download and gets `403` — artifact scope is
  inherited from the channel's visibility (AGENTS.md rule #14 "file
  storage is external, references stay permissioned").

### 4. Memory derivation

The `memory` plugin subscribes to `message.appended`, normalizes text
parts into **memory units** (chunked, deduplicated by content hash,
keyword-tagged), and records them in its own `memory_units` /
`memory_source_messages` tables. Each unit snapshots `source_stream_id`,
`source_stream_type`, and `source_visibility` at insertion time so a
later visibility change can never retroactively widen the audience
(AGENTS.md rules #6 and #15). When two messages carry identical text the
plugin records a second provenance edge instead of a duplicate unit.

Read paths delegate privacy to the core service via
`MessageLayer.assertCanReadStream` — the same function the HTTP layer
uses everywhere else.

### 5. Promotion → org-wide visibility

- Admin holds `memory:promote` → `POST /v1/memory/:id/promote`.
- The plugin route calls `service.recordMemoryPromotion`, which emits
  `memory.promoted` on the shared bus and into the hash-chained audit
  log — core owns the event, plugins only react (AGENTS.md rule #12).
- The plugin subscribes to `memory.promoted`, flips its `promoted` bit,
  and serves promoted units to any org member via
  `GET /v1/memory?promoted=true`.
- Non-promoted units remain scope-locked; the outsider can read exactly
  the promoted unit and nothing else.

### 6. Cross-entity search

The `search` plugin maintains a derived index over actors
(`human` / `agent` / `app`), channels, threads, messages, and (when the
`memory` plugin is also enabled) memory units. It composes with `memory`
via the in-process `registerMemoryIndexProvider` adapter — both plugins
remain independently runnable.

- Admin issues `GET /v1/search?q=v1.0` and gets ranked mixed-entity
  hits with snippet highlights.
- Filtered search: `GET /v1/search?q=coder&entityTypes=actor` narrows to
  actor names (and accepts `actorType=human|agent|app`).
- Outsider issues `GET /v1/search?q=plan` — the only memory hits are
  org-promoted ones, and no private message hits leak.

### 7. Audit trail

`GET /v1/audit/rows` (requires `audit:read`) returns every event
including:

- `org.created`, `membership.updated`, `channel.created`
- `message.appended`
- `grant.created`, `permission_request.created`, `permission_request.resolved`
- `artifact.registered`
- `memory.promoted`

`GET /v1/audit/verify` recomputes the sha256 hash chain and reports the
first inconsistent index.

## Agent onboarding through Better Auth + agent-auth

The `clients/nextjs` reference client uses
[`@better-auth/agent-auth`](https://github.com/better-auth/better-auth) to
expose this surface to external coding agents. Its configuration (see
`clients/nextjs/lib/auth.ts`) declares capabilities that map 1:1 onto the
core endpoints the hero flow exercises:

- `channels.read`  → `GET /v1/channels`
- `messages.read`  → `GET /v1/streams/:id/messages`
- `messages.append` → `POST /v1/messages`
- `memory.list` / `memory.search` / `memory.promote` → `/v1/memory/*`
- `search.query` → `GET /v1/search`

The agent obtains a bearer token via the Agent Auth flow, hits the
Next.js app's agent routes, and those routes call the core
`MessageLayer` functions with a server-side-derived `Principal`. The
core never trusts a browser-forged `x-principal` in that path — Better
Auth issues the session, Next.js maps it to a message-layer principal,
and the agent-auth `onExecute` handler runs the capability.

## Mapping to AGENTS.md key flows

| AGENTS.md key flow                           | Covered by                                               |
|----------------------------------------------|----------------------------------------------------------|
| 1. Human + agent + app in a channel          | bootstrap                                                |
| 2. Channel → thread workflow                 | exists in core; not exercised by this demo               |
| 3. Permission request lifecycle              | step 2                                                   |
| 4. Cross-device sync via cursor + WS         | exists in core; not exercised by this demo               |
| 5. Agent acting on behalf of human           | agent posts + uploads under its own actor + grants       |
| 6. Private scope isolation                   | outsider tests throughout                                |
| 7. File artifact lifecycle                   | step 3                                                   |
| 8. Message → knowledge derivation            | step 4 (`memory` plugin)                                 |
| 9. Realtime subscription + replay            | WS transport exists; not exercised by this demo          |
| 10. Full audit trace of a workflow           | step 7 (`/v1/audit/verify`)                              |

## Files

- `scripts/hero-flow.ts` — runnable narration (`pnpm run demo:hero`)
- `tests/e2e/hero-flow.test.ts` — machine-checked equivalent
- `tests/e2e/memory.test.ts` — memory plugin edge cases (dedup, redaction, promotion, search)
- `tests/e2e/search.test.ts` — search plugin standalone + composition with memory
- `src/plugins/memory.ts` — the memory plugin
- `src/plugins/search.ts` — the search plugin
- `src/service.ts` — `assertCanReadStream`, `recordMemoryPromotion`
