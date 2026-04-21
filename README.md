# message-layer

A headless messaging and coordination layer for humans, agents, and apps.

- **Messages are the center.** Actions, permissions, knowledge, and audit all flow through typed, append-only messages.
- **Minimal core, everything else is a plugin.** Core owns orgs, actors, channels, threads, messages, permissions, privacy, and audit.
- **One system, multiple modes.** Same service boots against PGlite (local/in-process) or Postgres via the same `SqlDatabase` interface.
- **Transport is swappable.** HTTP for commands, WebSocket for realtime push.
- **Permission-first.** Denials can be auto-converted into permission requests; approvals automatically issue grants.
- **Privacy is a hard boundary.** Private channels are invisible to non-members over HTTP and WebSocket.
- **Audit everything.** Every domain event lands in a per-org, hash-chained, append-only log verifiable via `GET /v1/audit/verify`.
- **Artifacts are first-class.** Binary payloads are registered per-stream, inherit stream privacy, and are stored through a pluggable `StorageAdapter`.

---

## Running the server

```bash
npm install message-layer
```

### Quickest start (in-process, PGlite)

```typescript
import { startServer } from "message-layer";

const server = await startServer();
// HTTP + WebSocket on http://localhost:3000
```

### With options

```typescript
import { startServer } from "message-layer";

const server = await startServer({
  port: 4000,
  storage: { adapter: "pglite", path: "./.data/db" },
  plugins: [
    "request-logging",
    { name: "api-key-header-auth", options: { strict: true } },
    "webhooks",
  ],
  websocket: true,
});

// Graceful shutdown
await server.close();
```

### With Postgres

```bash
STORAGE_ADAPTER=postgres \
STORAGE_PATH=postgresql://user:pass@localhost:5432/mydb \
node --enable-source-maps dist/server.js
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `STORAGE_ADAPTER` | `pglite` | `pglite` or `postgres` |
| `STORAGE_PATH` | `memory://server` | PGlite path or Postgres connection string |
| `ARTIFACTS_STORAGE` | `local-fs` | `local-fs` or `memory` |
| `ARTIFACTS_PATH` | `./.data/artifacts` | Blob storage directory (local-fs only) |
| `ARTIFACTS_MAX_BYTES` | `10485760` (10 MB) | Max artifact size in bytes |
| `PLUGINS` | _(none)_ | Comma-separated plugin names, e.g. `request-logging,webhooks` |
| `ENABLE_WEBSOCKET` | `true` | Enable WebSocket upgrade |
| `MESSAGE_LAYER_CONFIG` | _(none)_ | Full config as JSON string (overrides individual env vars) |

---

## TypeScript SDK

Install and use the HTTP client SDK to talk to a running message-layer server:

```typescript
import { MessageLayerClient } from "message-layer/sdk";

const client = new MessageLayerClient({
  baseUrl: "http://localhost:3000",
  principal: { actorId: "actor_123", orgId: "org_456", scopes: [], provider: "myapp" },
});

// List channels
const channels = await client.listChannels();

// Send a message
await client.appendMessage({
  streamId: channels[0].id,
  streamType: "channel",
  parts: [{ type: "text", payload: { text: "Hello!" } }],
});

// Subscribe to realtime events (WebSocket)
const ws = client.subscribe("channel_id", {
  onEvent: (event) => console.log(event),
});
ws.close();
```

### Creating orgs and actors (unauthenticated)

```typescript
import { MessageLayerClient } from "message-layer/sdk";

// Bootstrap client (no principal needed for org/actor creation)
const bootstrap = new MessageLayerClient({ baseUrl: "http://localhost:3000" });

const { orgId } = await bootstrap.createOrg("My Workspace");
const { actorId } = await bootstrap.createActor({
  orgId,
  displayName: "Alice",
  actorType: "human",
});

// Authenticated client
const client = new MessageLayerClient({
  baseUrl: "http://localhost:3000",
  principal: { actorId, orgId, scopes: ["channel:create", "grant:create"], provider: "myapp" },
});

const { channelId } = await client.createChannel("general");
```

---

## Embedding the service in-process

For tests or server-side embedding without HTTP:

```typescript
import { MessageLayer } from "message-layer";
import { openDatabase } from "message-layer";

const db = await openDatabase({ adapter: "pglite", path: "memory://test" });
const service = new MessageLayer(db);

const orgId = await service.createOrg("test");
const actorId = await service.createActor(orgId, "Alice", "human");
// ...all service methods available directly
```

---

## Plugins

Plugins extend message-layer with additional routes, event handlers, and schema migrations. They are registered at startup via config.

### Configuring plugins

**Via environment variable:**
```bash
PLUGINS=request-logging,webhooks node dist/server.js
```

**Via `startServer` options:**
```typescript
await startServer({
  plugins: [
    "request-logging",
    { name: "api-key-header-auth", options: { strict: true } },
    { name: "health-meta", options: { version: "1.2.0" } },
  ],
});
```

**Via `MESSAGE_LAYER_CONFIG` JSON:**
```bash
MESSAGE_LAYER_CONFIG='{"plugins":[{"name":"webhooks"},{"name":"request-logging"}]}' \
  node dist/server.js
```

### Built-in plugins

#### `request-logging`
Logs every HTTP request with method, path, status code, and duration.

| Option | Default | Description |
|---|---|---|
| `prefix` | `[ml]` | Log line prefix |

#### `health-meta`
Adds a `GET /health/meta` endpoint with adapter, version, and plugin list.

| Option | Default | Description |
|---|---|---|
| `includeAdapter` | `true` | Include storage adapter name |
| `version` | _(none)_ | Optional version string to include |

#### `api-key-header-auth`
Guards `/v1/*` routes with a static API key sent in a request header.

| Option | Default | Description |
|---|---|---|
| `headerName` | `x-api-key` | Header to read the key from |
| `envKey` | `MESSAGE_LAYER_API_KEY` | Env variable holding the expected key |
| `protectedPrefixes` | `["/v1/"]` | Path prefixes that require auth |
| `strict` | `false` | Return 503 if the env key is not set |

```bash
MESSAGE_LAYER_API_KEY=secret \
PLUGINS=api-key-header-auth \
node dist/server.js
```

#### `event-logger`
Logs every domain event emitted by the service.

| Option | Default | Description |
|---|---|---|
| `prefix` | `[event]` | Log line prefix |

#### `webhooks`
Delivers domain events as outbound HTTP POST requests to registered subscriber URLs.

- Adds `POST /v1/webhooks/subscriptions` — register a webhook
- Adds `GET /v1/webhooks/subscriptions` — list subscriptions
- Adds `PATCH /v1/webhooks/subscriptions/:id` — enable/disable

#### `scoped-knowledge`
Persists message-derived knowledge entries per stream. Every `message.appended` event is indexed; entries can be promoted org-wide.

- Adds `GET /v1/knowledge?streamId=…` — list knowledge entries for a stream
- Adds `POST /v1/knowledge/:id/promote` — promote an entry org-wide (requires `knowledge:promote`)

#### `durable-streams`
Append-only named streams with optional TTL, consumer checkpoints, and tail-read SSE. Useful for agent task queues and async pipelines.

- Adds `POST /v1/durable-streams` — create stream
- Adds `GET /v1/durable-streams/:id` — read / tail stream
- Adds `POST /v1/durable-streams/:id/commit` — commit checkpoint
- Adds `POST /v1/durable-streams/:id/close` — close stream

#### `in-memory-knowledge` _(legacy)_
Lightweight in-memory message index. Use `scoped-knowledge` for production; this plugin is retained for plugin-authoring examples and tests.

---

## HTTP API

Every authenticated request carries an `x-principal` JSON header. See [`docs/spec/authentication.md`](./docs/spec/authentication.md).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness probe |
| `POST` | `/v1/orgs` | Create org (unauthenticated) |
| `POST` | `/v1/actors` | Create actor (unauthenticated) |
| `GET` | `/v1/actors` | List actors in the principal's org |
| `GET` | `/v1/members` | List org memberships |
| `POST` | `/v1/channels` | Create channel |
| `GET` | `/v1/channels` | List channels visible to the principal |
| `POST` | `/v1/channels/:id/members` | Add channel member |
| `DELETE` | `/v1/channels/:id/members/:actorId` | Remove channel member |
| `GET` | `/v1/channels/:id/members` | List channel members |
| `POST` | `/v1/threads` | Create thread |
| `GET` | `/v1/channels/:id/threads` | List threads |
| `POST` | `/v1/messages` | Append message (idempotent, optional `autoRequestOnDeny`) |
| `POST` | `/v1/messages/:id/redact` | Redact message content |
| `GET` | `/v1/streams/:id/messages` | List messages |
| `GET` | `/v1/streams/:id/subscribe` | HTTP SSE replay of events |
| `POST` | `/v1/cursors` | Update read cursor |
| `GET` | `/v1/streams/:id/cursor` | Read cursor |
| `POST` | `/v1/grants` | Create grant |
| `POST` | `/v1/grants/:id/revoke` | Revoke grant |
| `GET` | `/v1/grants/check` | Check capability |
| `POST` | `/v1/permission-requests` | Open a permission request |
| `GET` | `/v1/permission-requests` | List open requests |
| `POST` | `/v1/permission-requests/:id/resolve` | Approve or deny |
| `POST` | `/v1/artifacts` | Register an artifact (base64 body, privacy-scoped) |
| `GET` | `/v1/artifacts/:id` | Artifact metadata |
| `GET` | `/v1/artifacts/:id/content` | Download artifact bytes |
| `GET` | `/v1/streams/:id/artifacts` | List artifacts attached to a stream |
| `DELETE` | `/v1/artifacts/:id` | Soft-delete an artifact |
| `POST` | `/v1/clients` | Register a client endpoint |
| `GET` | `/v1/audit/rows` | Export audit log (requires `audit:read`) |
| `GET` | `/v1/audit/verify` | Verify audit hash chain |
| `POST` | `/v1/webhooks/subscriptions` | Create webhook subscription (`webhooks` plugin) |
| `GET` | `/v1/webhooks/subscriptions` | List webhook subscriptions (`webhooks` plugin) |
| `PATCH` | `/v1/webhooks/subscriptions/:id` | Enable/disable webhook (`webhooks` plugin) |
| `GET` | `/v1/knowledge?streamId=…` | List knowledge entries (`scoped-knowledge` plugin) |
| `POST` | `/v1/knowledge/:id/promote` | Promote knowledge org-wide (`scoped-knowledge` plugin) |

---

## WebSocket

`ws://<host>/v1/ws` accepts the same principal (header or `?principal=…`) and speaks a tiny JSON protocol:

```
→ { "type": "subscribe",   "streamId": "…", "streamType": "channel|thread", "fromSeq": 0 }
→ { "type": "unsubscribe", "streamId": "…" }
→ { "type": "ping" }

← { "type": "welcome",    "actorId", "orgId" }
← { "type": "subscribed", "streamId", "lastSeq" }
← { "type": "event",      "event": { "type", "payload", "streamSeq", "createdAt" } }
← { "type": "pong" }
← { "type": "error",      "error": "…", "code"? }
```

Subscriptions replay events with `streamSeq > fromSeq` from the DB first, then push live events from the in-process event bus.

---

## Agent kernel & clients

- `src/agent-kernel/` — embeds the Pi coding agent in-process and routes every tool call through a permission gate: missing `tool:execute:<toolName>` → permission request → resolved by a human over HTTP → agent resumes. Import from `message-layer/agent-kernel`.
- `clients/terminal/` — interactive REPL on top of the kernel.
- `clients/nextjs/` — full web client with Better Auth, invites, attachments, and an approval inbox.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, test conventions, and how to add plugins and endpoints.
