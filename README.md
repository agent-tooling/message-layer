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

### In-process (PGlite)

```typescript
import { startServer } from "message-layer";
import { websocketPlugin } from "message-layer/plugins/websocket";

const server = await startServer({
  plugins: [websocketPlugin()],
});
// HTTP + WebSocket on http://localhost:3000
```

### With explicit storage and plugins

```typescript
import { startServer } from "message-layer";
import { pglite } from "message-layer/storage/pglite";
import { apiKeyAuthPlugin } from "message-layer/plugins/api-key-auth";
import { requestLoggingPlugin } from "message-layer/plugins/request-logging";
import { webhookPlugin } from "message-layer/plugins/webhooks";
import { websocketPlugin } from "message-layer/plugins/websocket";

const server = await startServer({
  port: 4000,
  config: { storage: pglite("./.data/db") },
  plugins: [
    requestLoggingPlugin(),
    apiKeyAuthPlugin({ strict: true }),
    webhookPlugin(),
    websocketPlugin(),
  ],
});

await server.close();
```

### With Postgres

```typescript
import { startServer } from "message-layer";
import { postgres } from "message-layer/storage/postgres";
import { websocketPlugin } from "message-layer/plugins/websocket";

await startServer({
  config: { storage: postgres(process.env.DATABASE_URL!) },
  plugins: [websocketPlugin()],
});
```

Or via environment variables:

```bash
STORAGE_ADAPTER=postgres \
STORAGE_PATH=postgresql://user:pass@localhost:5432/mydb \
PLUGINS=websocket,request-logging \
node --enable-source-maps dist/server.js
```

### Securing a public deployment

When the server is reachable over the public internet, gate it with a shared secret:

```typescript
import { apiKeyAuthPlugin } from "message-layer/plugins/api-key-auth";

await startServer({
  plugins: [apiKeyAuthPlugin({ strict: true })],
});
// Set MESSAGE_LAYER_API_KEY in the environment
```

Or via environment variables:

```bash
MESSAGE_LAYER_API_KEY=your-secret \
PLUGINS=api-key-header-auth \
node dist/server.js
```

All `/v1/*` requests — including the normally-unauthenticated `createOrg` and `createActor` — are rejected with `401` unless the correct key is present. `strict: true` returns `503` if the env variable is unset (catches misconfigured deployments).

Send the key from the SDK:

```typescript
const client = new MessageLayerClient({
  baseUrl: "https://ml.example.com",
  apiKey: process.env.MESSAGE_LAYER_API_KEY,
  principal: { ... },
});
```

Override the header name on both sides if needed:

```typescript
// Server
apiKeyAuthPlugin({ headerName: "x-ml-secret" })

// Client
new MessageLayerClient({ ..., apiKey: "...", apiKeyHeader: "x-ml-secret" })
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `STORAGE_ADAPTER` | `pglite` | `pglite` or `postgres` |
| `STORAGE_PATH` | `memory://server` | PGlite path or Postgres connection string |
| `ARTIFACTS_STORAGE` | `local-fs` | `local-fs`, `memory`, or `s3` |
| `ARTIFACTS_PATH` | `./.data/artifacts` | Blob storage directory (`local-fs` only) |
| `ARTIFACTS_MAX_BYTES` | `10485760` (10 MB) | Max artifact size in bytes |
| `ARTIFACTS_S3_BUCKET` | _(required for s3)_ | S3 bucket name |
| `ARTIFACTS_S3_REGION` | `us-east-1` | S3 / AWS region |
| `ARTIFACTS_S3_ENDPOINT` | _(none)_ | Custom endpoint (MinIO, R2, localstack) |
| `ARTIFACTS_S3_FORCE_PATH_STYLE` | `true` when endpoint is set | Force path-style URLs |
| `ARTIFACTS_S3_ACCESS_KEY_ID` | _(AWS credential chain)_ | Static access key ID |
| `ARTIFACTS_S3_SECRET_ACCESS_KEY` | _(AWS credential chain)_ | Static secret access key |
| `PLUGINS` | _(none)_ | Comma-separated plugin names, e.g. `request-logging,webhooks` |
| `MESSAGE_LAYER_API_KEY` | _(none)_ | Shared secret for `api-key-header-auth` plugin |
| `MESSAGE_LAYER_TOKEN_SECRET` | _(none)_ | HS256 signing secret for `principal-token-auth` plugin |
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

For tests or server-side embedding without HTTP, use the storage subpaths:

```typescript
import { createPgliteDatabase } from "message-layer/storage/pglite";
import { MessageLayer } from "message-layer";

const db = await createPgliteDatabase("memory://test");
const service = new MessageLayer(db);

const orgId = await service.createOrg("test");
const actorId = await service.createActor(orgId, "Alice", "human");
// ...all service methods available directly
```

The `pglite()` and `postgres()` factories return storage config descriptors for use with `startServer`:

```typescript
import { pglite } from "message-layer/storage/pglite";
import { postgres } from "message-layer/storage/postgres";

// startServer uses these as config.storage:
const s1 = pglite("./.data/mydb");   // { adapter: "pglite",    path: "./.data/mydb" }
const s2 = postgres(process.env.DB_URL!); // { adapter: "postgres", path: "<url>" }
```

---

## Plugins

Plugins extend message-layer with additional routes, event handlers, and schema migrations. They are registered at startup via config.

### Plugin system

Each plugin is a standalone subpath import:

```typescript
import { requestLoggingPlugin } from "message-layer/plugins/request-logging";
import { healthMetaPlugin }     from "message-layer/plugins/health-meta";
import { apiKeyAuthPlugin }     from "message-layer/plugins/api-key-auth";
import { eventLoggerPlugin }    from "message-layer/plugins/event-logger";
import { webhookPlugin }        from "message-layer/plugins/webhooks";
import { websocketPlugin }      from "message-layer/plugins/websocket";
import { memoryPlugin }         from "message-layer/plugins/memory";
import { searchPlugin }         from "message-layer/plugins/search";
import { durableStreamsPlugin }  from "message-layer/plugins/durable-streams";

await startServer({
  plugins: [
    requestLoggingPlugin(),
    healthMetaPlugin({ version: "1.2.0" }),
    apiKeyAuthPlugin({ strict: true }),
    websocketPlugin(),
    webhookPlugin(),
  ],
});
```

Plugins can also be specified by name via environment variable:

```bash
PLUGINS=request-logging,websocket,webhooks node dist/server.js
```

Or as JSON in `MESSAGE_LAYER_CONFIG`:

```bash
MESSAGE_LAYER_CONFIG='{"plugins":[{"name":"websocket"},{"name":"webhooks"}]}' \
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

#### `principal-token-auth`
Browser-friendly token authentication. The host application mints a short-lived HS256 JWT identifying an actor; the plugin verifies it and injects `x-principal` (and optionally `x-api-key`) so downstream handlers — and the WebSocket upgrade — see a fully authenticated request **without** the browser ever holding the long-lived API key.

Accepts the token as:

- `Authorization: Bearer <jwt>` header (HTTP)
- `?token=<jwt>` query parameter (HTTP and WebSocket — browsers cannot set headers on `WebSocket()` construction)

| Option | Default | Description |
|---|---|---|
| `envKey` | `MESSAGE_LAYER_TOKEN_SECRET` | Env variable holding the HS256 signing secret |
| `queryName` | `token` | Query parameter name for browser clients |
| `injectApiKey` | `true` | When true (the default), inject `x-api-key` after validation so `api-key-header-auth` accepts the request. Pass `false` for a token-only deployment. |
| `apiKeyEnvKey` | `MESSAGE_LAYER_API_KEY` | Env variable read when `injectApiKey` is true |
| `apiKeyHeader` | `x-api-key` | Header name to inject the API key under |
| `protectedPrefixes` | `["/v1/"]` | Path prefixes the plugin acts on |
| `replayWindowSeconds` | `0` (disabled) | Track `jti` per token in-process; reject replays within this window |

Token claims (HS256 JWT):

```json
{
  "sub": "actor_<id>",
  "oid": "org_<id>",
  "scp": ["channel:admin", "message:append"],
  "pvd": "homebrewtales/web",
  "iat": 1779000000,
  "exp": 1779003600,
  "jti": "unique-id"
}
```

A helper `mintPrincipalToken({ secret, actorId, orgId, scopes, ttlSeconds, jti })` is exported from `message-layer/plugins/principal-token-auth` for trusted host code.

```bash
MESSAGE_LAYER_API_KEY=secret \
MESSAGE_LAYER_TOKEN_SECRET=token-secret \
PLUGINS=api-key-header-auth,principal-token-auth,websocket \
node dist/server.js
```

**Plugin ordering matters when used together with `api-key-header-auth`:** register `api-key-header-auth` first and `principal-token-auth` second. Both hook the `upgrade` event with `prependListener`, so the later registration runs first on upgrade — that's what allows `principal-token-auth` to inject `x-api-key` before the api-key plugin checks for it.

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

#### `memory`
Derives reusable **memory units** from text parts of `message.appended` events. Units are normalized, chunked, deduplicated by content hash, and tagged with extracted keywords — never a 1:1 copy of message text. Source `streamId` / `streamType` / `visibility` are snapshotted at insert time so derived data cannot widen retroactively.

- Adds `GET /v1/memory?streamId=…` — list memory bound to a stream
- Adds `GET /v1/memory?promoted=true` — list org-wide promoted memory
- Adds `GET /v1/memory/search?q=…` — lexical search over visible memory
- Adds `GET /v1/memory/:id` — fetch one unit (with provenance + keywords)
- Adds `POST /v1/memory/:id/promote` — promote a unit org-wide (requires `memory:promote`)

Composes optionally with the `search` plugin via `registerMemoryIndexProvider` — neither plugin requires the other.

#### `search`
Privacy-aware lexical search across actors (`human` / `agent` / `app`), channels, threads, messages, threaded messages, and (when `memory` is enabled) memory units. Results are filtered through the same core privacy checks the rest of the system uses — private messages and threads never leak to non-members.

- Adds `GET /v1/search?q=…&entityTypes=…&streamId=…&actorType=…&limit=…` — mixed-entity ranked search
- Adds `GET /v1/search/suggest?q=…` — lightweight autosuggest for actors / channels / threads

#### `durable-streams`
Append-only named streams with optional TTL, consumer checkpoints, and tail-read SSE. Useful for agent task queues and async pipelines. Chunk data is stored in SQL rows.

- Adds `POST /v1/durable-streams` — create stream
- Adds `GET /v1/durable-streams/:id` — read / tail stream
- Adds `POST /v1/durable-streams/:id/commit` — commit checkpoint
- Adds `POST /v1/durable-streams/:id/close` — close stream

#### `durable-streams-storage`
#### `genui` — Generative UI message parts

Agents post `ui` message parts containing a [json-render](https://github.com/vercel-labs/json-render) spec. The spec describes a UI tree (components + props + children); the Next.js client renders it using a curated registry of shadcn-style components.

**Core (message-layer server)** — zero new routes required. The `ui` type is a first-class member of `messagePartTypes`:

```json
{
  "type": "ui",
  "payload": {
    "catalog": "shadcn",
    "spec": {
      "root": "card-1",
      "elements": {
        "card-1": { "type": "Card", "props": { "title": "Sprint metrics" }, "children": ["m1"] },
        "m1":     { "type": "Metric", "props": { "label": "PRs merged", "value": "17", "trend": "up" }, "children": [] }
      }
    }
  }
}
```

**Catalog** — 16 components, inspired by shadcn/ui, rendered with Tailwind CSS:

`Stack`, `Card`, `Separator` · `Heading`, `Text` · `Badge`, `Alert`, `Metric`, `Progress` · `Table`, `TableRow`, `TableCell` · `Button` · `Input`, `Checkbox` · `List`, `ListItem` · `Code`

**Client** — `GenuiPartView` renders any `ui` part inside `MessageCard`. The component lives at `clients/nextjs/components/genui/`.

**Demo** — visit `http://localhost:3001/genui-demo` (no auth required) to see every component live.


Storage-backed variant of `durable-streams`. Chunk data is written to the blob `StorageAdapter` (memory / local-fs / **S3**) rather than SQL rows, keeping the DB lean for large payloads (streaming LLM output, log tails, binary frames, etc.).

Uses the same storage adapter that backs artifacts — configure S3 for artifacts and durable-streams-storage automatically uses S3.

- Adds `POST /v1/durable-streams-storage` — create stream
- Adds `GET /v1/durable-streams-storage/:id/head` — metadata
- Adds `POST /v1/durable-streams-storage/:id/chunks` — append chunk(s) → stored in StorageAdapter
- Adds `GET /v1/durable-streams-storage/:id/read` — batch-read chunks from storage
- Adds `GET /v1/durable-streams-storage/:id/tail` — SSE live tail
- Adds `POST /v1/durable-streams-storage/:id/close` — close + write manifest
- Adds `POST /v1/durable-streams-storage/:id/commit` — assemble + post as a single channel message

```typescript
import { durableStreamsStoragePlugin } from "message-layer/plugins/durable-streams-storage";
import { s3 } from "message-layer/storage/s3";

await startServer({
  config: {
    artifacts: s3({ bucket: "my-bucket", region: "us-east-1" }),
  },
  plugins: [durableStreamsStoragePlugin()],
});
```

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
| `POST` | `/v1/commands` | Register a slash command (opens a `command:register` approval request) |
| `GET` | `/v1/commands` | List active commands (`?channelId=` includes channel-scoped) |
| `DELETE` | `/v1/commands/:id` | Disable a command (owner or admin) |
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
| `GET` | `/v1/memory?streamId=…` | List memory units bound to a stream (`memory` plugin) |
| `GET` | `/v1/memory/search?q=…` | Lexical search over visible memory (`memory` plugin) |
| `GET` | `/v1/memory/:id` | Fetch one memory unit (`memory` plugin) |
| `POST` | `/v1/memory/:id/promote` | Promote memory org-wide (`memory` plugin) |
| `GET` | `/v1/search?q=…` | Mixed-entity privacy-aware search (`search` plugin) |
| `GET` | `/v1/search/suggest?q=…` | Autosuggest for actors / channels / threads (`search` plugin) |

`MessagePart.type` includes `text`, `mention`, `command`, `tool_call`,
`tool_result`, `artifact`, `approval_request`, `approval_response`, and `ui`.
`command` parts require `command:invoke` on the target stream in addition to
`message:append`; when `autoRequestOnDeny` is enabled, denied command calls
auto-open a `command:invoke` permission request with structured context.

**Slash command registry** — apps and agents register named commands via
`POST /v1/commands`. Each registration opens a `command:register` permission
request that an admin resolves. Once approved the command becomes active:
short-form invocations (`command: "deploy"`) are resolved to the owning
actor; long-form (`command: "deploybot:deploy"`) is always unambiguous.
Multiple owners may hold the same short name; invoking the short form when
two registrations are active is a `ValidationError` — use the long form.
Invocations of unregistered commands pass through with `commandId: null`
(backward compatible). `command.invoked` events now carry `commandId` and
`ownerActorId` so subscribers can route without polling.

---

## WebSocket

```typescript
import { websocketPlugin } from "message-layer/plugins/websocket";
await startServer({ plugins: [websocketPlugin()] });
```

Or via env: `PLUGINS=websocket`.

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
