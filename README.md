# message-layer

A headless messaging and coordination layer for humans, agents, and apps.

- **Messages are the center.** Actions, permissions, knowledge, and audit all
  flow through typed, append-only messages.
- **Minimal core, everything else is a plugin.** Core owns orgs, actors,
  channels, threads, messages, permissions, privacy, audit.
- **One system, multiple modes.** Same service boots against PGlite (local)
  or Postgres via the same `SqlDatabase` interface.
- **Transport is swappable.** HTTP for commands, WebSocket for realtime.
- **Permission-first.** Denials can be converted into permission requests;
  approvals automatically issue grants.
- **Privacy is a hard boundary.** Private channels are invisible to
  non-members and non-readable over HTTP or WebSocket.
- **Audit everything.** Every domain event goes into a per-org, hash-chained
  append-only log, verifiable via `GET /v1/audit/verify`.
- **Artifacts are first-class.** Binary payloads are registered per-stream,
  inherit stream privacy, and are stored through a pluggable blob
  `StorageAdapter` (local filesystem by default; in-memory for tests; S3
  and friends slot in via the same interface).

## Quick start

```
pnpm install
pnpm run dev          # HTTP + WS on http://localhost:3000
pnpm run demo:hero    # narrated in-process end-to-end demo
pnpm run test         # 95-test suite across unit + e2e, no mocks
```

For local development setup, see [CONTRIBUTING.md](./CONTRIBUTING.md).
Full API reference lives in [`docs/spec/`](./docs/spec/). The end-to-end
developer story — human + agent + app in one channel, permission
request, artifact upload, scoped knowledge, audit trail — is documented
in [`docs/hero-flow.md`](./docs/hero-flow.md).

## HTTP (condensed)

| Method   | Path                                  | Purpose                                                        |
| -------- | ------------------------------------- | -------------------------------------------------------------- |
| `GET`    | `/health`                             | Liveness probe                                                 |
| `POST`   | `/v1/orgs`                            | Create org (unauthenticated)                                   |
| `POST`   | `/v1/actors`                          | Create actor (unauthenticated)                                 |
| `GET`    | `/v1/actors`                          | List actors in the principal's org                             |
| `GET`    | `/v1/members`                         | List org memberships                                           |
| `POST`   | `/v1/channels`                        | Create channel                                                 |
| `GET`    | `/v1/channels`                        | List channels visible to the principal                         |
| `POST`   | `/v1/channels/:id/members`            | Add channel member                                             |
| `DELETE` | `/v1/channels/:id/members/:actorId`   | Remove channel member                                          |
| `GET`    | `/v1/channels/:id/members`            | List channel members                                           |
| `POST`   | `/v1/threads`                         | Create thread                                                  |
| `GET`    | `/v1/channels/:id/threads`            | List threads                                                   |
| `POST`   | `/v1/messages`                        | Append message (idempotent + optional `autoRequestOnDeny`)     |
| `POST`   | `/v1/messages/:id/redact`             | Redact message content (slot preserved)                        |
| `GET`    | `/v1/streams/:id/messages`            | List messages                                                  |
| `GET`    | `/v1/streams/:id/subscribe`           | HTTP replay of events                                          |
| `POST`   | `/v1/cursors`                         | Update read cursor                                             |
| `GET`    | `/v1/streams/:id/cursor`              | Read cursor                                                    |
| `POST`   | `/v1/grants`                          | Create grant                                                   |
| `POST`   | `/v1/grants/:id/revoke`               | Revoke grant                                                   |
| `GET`    | `/v1/grants/check`                    | Check capability                                               |
| `POST`   | `/v1/permission-requests`             | Open a permission request                                      |
| `GET`    | `/v1/permission-requests`             | List open requests                                             |
| `POST`   | `/v1/permission-requests/:id/resolve` | Approve or deny                                                |
| `GET`    | `/v1/knowledge?streamId=…`            | List derived knowledge entries (via `scoped-knowledge` plugin) |
| `POST`   | `/v1/knowledge/:id/promote`           | Promote an entry org-wide (requires `knowledge:promote`)       |
| `POST`   | `/v1/artifacts`                       | Register an artifact (base64 body, privacy-scoped)             |
| `GET`    | `/v1/artifacts/:id`                   | Artifact metadata                                              |
| `GET`    | `/v1/artifacts/:id/content`           | Download artifact bytes                                        |
| `GET`    | `/v1/streams/:id/artifacts`           | List artifacts attached to a stream                            |
| `DELETE` | `/v1/artifacts/:id`                   | Soft-delete an artifact                                        |
| `POST`   | `/v1/clients`                         | Register a client endpoint                                     |
| `POST`   | `/v1/webhooks/subscriptions`          | Create webhook subscription (via `webhooks` plugin)            |
| `GET`    | `/v1/webhooks/subscriptions`          | List webhook subscriptions (via `webhooks` plugin)             |
| `PATCH`  | `/v1/webhooks/subscriptions/:id`      | Enable/disable webhook subscription (via `webhooks` plugin)    |
| `GET`    | `/v1/audit/rows`                      | Export audit log (requires `audit:read` scope)                 |
| `GET`    | `/v1/audit/verify`                    | Verify audit hash chain                                        |

Every authenticated request carries an `x-principal` JSON header. See
[`docs/spec/authentication.md`](./docs/spec/authentication.md).

## WebSocket

`ws://<host>/v1/ws` accepts the same principal (header or `?principal=…`)
and speaks a tiny JSON protocol:

```
→ { "type": "subscribe", "streamId": "…", "streamType": "channel|thread", "fromSeq": 0 }
→ { "type": "unsubscribe", "streamId": "…" }
→ { "type": "ping" }

← { "type": "welcome", "actorId", "orgId" }
← { "type": "subscribed", "streamId", "lastSeq" }
← { "type": "event", "event": { "type", "payload", "streamSeq", "createdAt" } }
← { "type": "pong" }
← { "type": "error", "error": "…", "code"? }
```

Subscriptions first replay events with `streamSeq > fromSeq` from the DB and
then push live events from the in-process event bus.

## Agent kernel & clients

- `src/agent-kernel/` embeds the Pi coding agent in-process and routes every
  tool call through a permission gate: missing `tool:execute:<toolName>` →
  permission request → resolved by a human over HTTP → agent resumes.
- `clients/terminal/` is an interactive REPL on top of the kernel.
- `clients/nextjs/` is a full web client with Better Auth, invites,
  attachments, and an approval inbox.
