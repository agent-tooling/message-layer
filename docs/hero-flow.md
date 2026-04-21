# Hero flow

The AGENTS.md "must work" key flows, exercised as one cohesive developer
story:

> a developer runs message-layer locally, attaches a **human**, **agent**,
> and **app** to one channel, sees a permission request flow, uploads an
> artifact, derives scoped knowledge, and inspects the full audit trail.

This document describes the flow, how to run it, and how it maps onto the
principles in [`AGENTS.md`](../AGENTS.md).

## Run it

```bash
pnpm install
pnpm run demo:hero          # narrated in-process demo
pnpm run test               # 95-test suite including `tests/e2e/hero-flow.test.ts`
```

`demo:hero` boots a real server on an ephemeral port with the
`scoped-knowledge` plugin, drives everything through HTTP, and prints a
colored narration. No external services, no Docker.

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

### 4. Scoped knowledge derivation

The `scoped-knowledge` plugin subscribes to `message.appended`, extracts
text parts, and records entries in its own `knowledge_entries` table. Each
entry snapshots `source_stream_id` **and** `source_visibility` at
insertion time.

Read path delegates privacy to the core service via
`MessageLayer.assertCanReadStream` — the same function the HTTP layer
uses. Derived data is never more visible than its source (AGENTS.md
rule #6 and #15) unless explicitly promoted.

### 5. Promotion → org-wide visibility

- Admin holds `knowledge:promote` → `POST /v1/knowledge/:id/promote`.
- The plugin route calls `service.recordKnowledgePromotion`, which emits
  `knowledge.promoted` on the shared bus and into the hash-chained audit
  log — core owns the event, plugins only react (AGENTS.md rule #12).
- The plugin subscribes to `knowledge.promoted`, flips its `promoted` bit,
  and serves promoted entries to any org member via
  `GET /v1/knowledge?includePromotedElsewhere=true`.
- Non-promoted entries remain scope-locked; the outsider can read exactly
  the promoted entry and nothing else.

### 6. Audit trail

`GET /v1/audit/rows` (requires `audit:read`) returns every event
including:

- `org.created`, `membership.updated`, `channel.created`
- `message.appended`
- `grant.created`, `permission_request.created`, `permission_request.resolved`
- `artifact.registered`
- `knowledge.promoted`

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

The agent obtains a bearer token via the Agent Auth flow, hits the
Next.js app's agent routes, and those routes call the core
`MessageLayer` functions with a server-side-derived `Principal`. The
core never trusts a browser-forged `x-principal` in that path — Better
Auth issues the session, Next.js maps it to a message-layer principal,
and the agent-auth `onExecute` handler runs the capability.

To extend the agent's reach to the rest of the hero flow (artifacts,
knowledge), add corresponding capability descriptors in
`clients/nextjs/lib/auth.ts` and route them to `service.registerArtifact`
and the `/v1/knowledge` plugin routes. The core contract stays the same.

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
| 8. Message → knowledge derivation            | step 4                                                   |
| 9. Realtime subscription + replay            | WS transport exists; not exercised by this demo          |
| 10. Full audit trace of a workflow           | step 6 (`/v1/audit/verify`)                              |

## Files

- `scripts/hero-flow.ts` — runnable narration (`pnpm run demo:hero`)
- `tests/e2e/hero-flow.test.ts` — machine-checked equivalent
- `tests/e2e/scoped-knowledge.test.ts` — plugin-focused edge cases
- `src/plugins/scoped-knowledge.ts` — the plugin
- `src/service.ts` — `assertCanReadStream`, `recordKnowledgePromotion`
