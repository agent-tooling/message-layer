# Plugins

message-layer's plugin system extends the server with additional routes, event
handlers, and schema migrations without modifying core. The core service only
handles orgs, actors, channels, threads, messages, grants, permission requests,
artifacts, cursors, clients, and audit. Everything else is a plugin.

---

## Configuration

Plugins are passed to `startServer` as an array. Each plugin is a standalone subpath import:

```typescript
import { startServer } from "message-layer";
import { requestLoggingPlugin } from "message-layer/plugins/request-logging";
import { healthMetaPlugin }     from "message-layer/plugins/health-meta";
import { apiKeyAuthPlugin }     from "message-layer/plugins/api-key-auth";
import { eventLoggerPlugin }    from "message-layer/plugins/event-logger";
import { webhookPlugin }        from "message-layer/plugins/webhooks";
import { telegramBridgePlugin } from "message-layer/plugins/telegram-bridge";
import { websocketPlugin }      from "message-layer/plugins/websocket";
import { memoryPlugin }         from "message-layer/plugins/memory";
import { searchPlugin }         from "message-layer/plugins/search";
import { durableStreamsPlugin }  from "message-layer/plugins/durable-streams";

await startServer({
  plugins: [
    requestLoggingPlugin({ prefix: "[app]" }),
    healthMetaPlugin({ version: "2.0.0" }),
    apiKeyAuthPlugin({ strict: true }),
    telegramBridgePlugin({
      publicBaseUrl: "https://ml.example.com",
      webhookSecretSigningKey: process.env.TELEGRAM_WEBHOOK_SECRET_KEY!,
    }),
    websocketPlugin(),
  ],
});
```

Plugins can also be specified by string name via `PLUGINS` env var:

```bash
PLUGINS=request-logging,websocket,webhooks node dist/server.js
```

Or as `{ name, options }` descriptors in `MESSAGE_LAYER_CONFIG`:

```bash
MESSAGE_LAYER_CONFIG='{"plugins":[{"name":"websocket"},{"name":"webhooks"}]}' \
  node dist/server.js
```

Plugins are started in declaration order. `setup` runs before `registerRoutes`.

---

## Plugin lifecycle

Each plugin is a plain object with optional lifecycle hooks:

```typescript
type ServerPlugin = {
  name: string;

  /** SQL migration statements for plugin-owned tables. */
  schemaSql?: PluginSchemaDef | PluginSchemaDef[];

  /** Called once at startup. Use to subscribe to events or wrap fetch. */
  setup?: (ctx: PluginRuntimeContext) => void | Promise<void>;

  /** Called after setup. Use to mount new HTTP routes on ctx.app. */
  registerRoutes?: (ctx: PluginRuntimeContext) => void | Promise<void>;

  /**
   * Convenience hook called for every DomainEvent on the shared bus.
   * Equivalent to calling ctx.bus.subscribe in setup.
   */
  onEvent?: (event: DomainEvent, ctx: PluginRuntimeContext) => void | Promise<void>;

  /** Called on server shutdown. Use to release resources. */
  dispose?: () => void | Promise<void>;
};
```

### `PluginRuntimeContext`

```typescript
type PluginRuntimeContext = {
  app: Hono;            // Hono HTTP application — mount routes here
  db: SqlDatabase;      // raw DB access (use sparingly; prefer service methods)
  service: MessageLayerService; // the core service
  bus: EventBus;        // in-process event bus
  config: ServerConfig; // resolved server config
  logger: (msg: string) => void; // write to the server log
  env: NodeJS.ProcessEnv; // environment variables passed at startup
  wrapFetch: (wrapper: FetchWrapper) => void; // inject HTTP middleware
};
```

### `wrapFetch`

`ctx.wrapFetch` wraps the Hono app's `fetch` handler with a middleware function.
Wrappers are applied in declaration order (first plugin = outermost wrapper).

```typescript
ctx.wrapFetch((next) => async (request, ...args) => {
  // before request
  const response = await next(request, ...args);
  // after response
  return response;
});
```

---

## Built-in plugins

### `request-logging`

Logs every HTTP request with method, path, status code, and response time.

| Option | Type | Default | Description |
|---|---|---|---|
| `prefix` | `string` | `"[ml]"` | Prefix prepended to each log line. |

```typescript
{ name: "request-logging", options: { prefix: "[myapp]" } }
```

---

### `health-meta`

Adds a `GET /health/meta` endpoint with server metadata.

| Option | Type | Default | Description |
|---|---|---|---|
| `includeAdapter` | `boolean` | `true` | Include the storage adapter name in the response. |
| `version` | `string` | _(none)_ | Optional version string to include. |

```typescript
{ name: "health-meta", options: { version: "1.2.3" } }
```

Response:

```json
{ "ok": true, "adapter": "pglite", "version": "1.2.3", "plugins": ["health-meta"] }
```

---

### `api-key-header-auth`

Guards every `/v1/*` route with a static shared secret. Useful when the server
is exposed over the public internet. See
[authentication.md](./authentication.md#server-level-api-key-gating) for the
full deployment pattern.

| Option | Type | Default | Description |
|---|---|---|---|
| `headerName` | `string` | `"x-api-key"` | Header the client sends the key in. |
| `envKey` | `string` | `"MESSAGE_LAYER_API_KEY"` | Env variable holding the expected key. |
| `protectedPrefixes` | `string[]` | `["/v1/"]` | URL path prefixes that require auth. |
| `strict` | `boolean` | `false` | Return `503` if the env variable is unset (prevents accidental open-access deployments). |

```typescript
{
  name: "api-key-header-auth",
  options: {
    strict: true,
    headerName: "x-ml-secret",
    envKey: "MY_ML_SECRET",
  }
}
```

Corresponding SDK usage:

```typescript
const client = new MessageLayerClient({
  baseUrl: "https://ml.example.com",
  apiKey: process.env.MY_ML_SECRET,
  apiKeyHeader: "x-ml-secret",
  principal: { ... },
});
```

---

### `event-logger`

Logs every `DomainEvent` emitted by the core service.

| Option | Type | Default | Description |
|---|---|---|---|
| `prefix` | `string` | `"[event]"` | Prefix prepended to each log line. |

---

### `webhooks`

Delivers domain events to registered subscriber URLs via outbound HTTP POST.

**Routes added:**

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/webhooks/subscriptions` | Register a webhook subscription. Requires `webhook:subscribe`. |
| `GET` | `/v1/webhooks/subscriptions` | List subscriptions. Requires `webhook:read`. |
| `PATCH` | `/v1/webhooks/subscriptions/:id` | Enable or disable a subscription. |

**Delivery:** when a matching event fires, the plugin POSTs the event payload
as JSON to the subscription's `endpoint`. Delivery is best-effort and
fire-and-forget (no retry logic in the built-in implementation).

Subscription body:

```json
{
  "endpoint": "https://my-app.com/hooks",
  "eventTypes": ["message.appended", "permission_request.created"],
  "streamId": "channel_abc123"
}
```

---

### `telegram-bridge`

See [telegram-bridge.md](./telegram-bridge.md) for the full lifecycle and data
model contract.

This plugin defines an explicit one-chat Telegram projection for a single
human + channel binding:

- inbound Telegram messages append to message-layer as the bound human actor
- outbound agent/app channel replies project to the same Telegram chat
- message-layer remains canonical for permissions, privacy, and audit

**Routes added:**

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/bridges/telegram/setups` | Register bot token and create setup. |
| `GET` | `/v1/bridges/telegram/setups` | List setups. |
| `GET` | `/v1/bridges/telegram/setups/:setupId` | Read setup status and binding. |
| `POST` | `/v1/bridges/telegram/setups/:setupId/disable` | Disable setup. |
| `POST` | `/v1/bridges/telegram/setups/:setupId/rotate-webhook-secret` | Rotate webhook secret and re-register webhook. |
| `POST` | `/v1/bridges/telegram/webhook/:setupId` | Telegram webhook ingress endpoint. |

| Option | Type | Default | Description |
|---|---|---|---|
| `mountPath` | `string` | `"/v1/bridges/telegram"` | Base route path for setup + webhook endpoints. |
| `publicBaseUrl` | `string` | `process.env.PUBLIC_BASE_URL` | Public HTTPS origin used to derive webhook URLs. |
| `webhookSecretSigningKey` | `string` | `process.env.TELEGRAM_WEBHOOK_SECRET_KEY` | Server-side secret used to derive per-setup webhook secret tokens and encrypt bot tokens at rest. |
| `telegramApiBaseUrl` | `string` | `"https://api.telegram.org"` | Telegram Bot API origin (override in tests/self-hosted gateways). |
| `requestTimeoutMs` | `number` | `5000` | Timeout for Telegram API calls (`getMe`, `setWebhook`, `deleteWebhook`, `sendMessage`). |

See [http-api.md](./http-api.md) for full request/response shapes.

---

### `memory`

Derives reusable **memory units** from text parts of `message.appended`
events. Memory is not a verbatim copy of messages: each unit is normalized,
chunked, deduplicated by content hash, and tagged with extracted keywords
so the same insight posted twice collapses into one unit (with multiple
provenance edges in `memory_source_messages`). The plugin handles
`message.redacted` by removing tombstoned source links and deleting the
unit when no live messages remain.

Source `streamId`, `streamType`, and `visibility` are snapshotted at
insertion time, matching the AGENTS.md rule that derived data must never
be more visible than its source unless explicitly promoted via the audited
`recordMemoryPromotion` core hook (which emits the `memory.promoted`
event consumed by this plugin).

**Routes added:**

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/memory?streamId=…` | List memory units bound to a stream. |
| `GET` | `/v1/memory?promoted=true` | List org-wide promoted memory. |
| `GET` | `/v1/memory/search?q=…` | Lexical search across visible memory. |
| `GET` | `/v1/memory/:memoryId` | Fetch a single unit (with provenance). |
| `POST` | `/v1/memory/:memoryId/promote` | Promote a unit org-wide (requires `memory:promote`). |

The plugin exposes a tiny in-process composition adapter:
`registerMemoryIndexProvider(handler)` from `message-layer/plugins/memory`
lets other plugins (the built-in `search` plugin uses it) subscribe to
`MemoryIndexEvent`s. Composition is optional — memory works standalone
and `search` works without `memory`.

See [http-api.md](./http-api.md) for full request/response shapes.

---

### `search`

Privacy-aware lexical search across the core entities the message-layer
manages: actors (`human` / `agent` / `app`), channels, threads, messages
(including threaded messages), and — when the `memory` plugin is enabled
— derived memory units. The plugin owns its own `search_documents` table
(plus a small composition adapter) and is populated by domain events:

| Event                          | Effect                            |
|--------------------------------|------------------------------------|
| `membership.updated` (org)     | upsert `actor` document            |
| `channel.created`              | upsert `channel` document          |
| `thread.created`               | upsert `thread` document           |
| `message.appended`             | upsert `message` document          |
| `message.redacted`             | delete the `message` document      |
| `MemoryIndexEvent` (composition) | upsert / delete `memory` document |

Every result is privacy-filtered by delegating to the same core service
methods used by the rest of the system (`assertCanReadStream`, org
membership checks). Promoted memory is readable across streams the way
the core promotion contract requires, but private message and thread
content never leaks.

**Routes added:**

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/search?q=…` | Mixed-entity ranked search. Supports `entityTypes`, `streamId`, `actorType`, `limit`. |
| `GET` | `/v1/search/suggest?q=…` | Lightweight autosuggest for actors, channels, and threads. |

See [http-api.md](./http-api.md) for full request/response shapes.

---

### `websocket`

Attaches a WebSocket server to the HTTP server after it is bound to a port.

| Option | Type | Default | Description |
|---|---|---|---|
| `path` | `string` | `"/v1/ws"` | WebSocket endpoint path. |

```typescript
import { websocketPlugin } from "message-layer/plugins/websocket";

await startServer({
  plugins: [websocketPlugin()],
});
```

Via env: `PLUGINS=websocket`.

---

### `durable-streams`

Append-only named streams with optional TTL, consumer checkpoints, and
SSE tail-reads. Designed for progressive agent output (token streaming),
async task queues, and any pipeline where the consumer needs resumable reads
before the final message is committed to a channel.

**Routes added:**

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/durable-streams` | Create a durable stream. |
| `POST` | `/v1/durable-streams/:id/chunks` | Append text chunks. |
| `GET` | `/v1/durable-streams/:id/read` | Read chunks (polling or long-poll). |
| `GET` | `/v1/durable-streams/:id/tail` | SSE live stream of chunks. |
| `POST` | `/v1/durable-streams/:id/close` | Close the stream and persist a backup. |
| `POST` | `/v1/durable-streams/:id/commit` | Concat all chunks and write a message to the target channel/thread. |

See [http-api.md](./http-api.md) for full request/response shapes.

---

## Storage adapters

Storage adapters are separate subpath exports for the SQL database layer.

```typescript
import { pglite, createPgliteDatabase } from "message-layer/storage/pglite";
import { postgres, createPostgresDatabase } from "message-layer/storage/postgres";

// Config descriptors (pass to startServer as config.storage)
pglite("./.data/mydb")                  // { adapter: "pglite",    path: "./.data/mydb" }
pglite("memory://test")                 // { adapter: "pglite",    path: "memory://test" }
postgres("postgresql://user:pass@/db")  // { adapter: "postgres",  path: "<url>" }

// Direct database creation (for in-process embedding)
const db = await createPgliteDatabase("memory://test");
const db = await createPostgresDatabase(process.env.DATABASE_URL!);
```

---

## Writing a plugin

1. Create a factory function in `src/plugins/<your-plugin>.ts`:

```typescript
import type { PluginFactory } from "../plugins.js";

export const myPlugin: PluginFactory = (options = {}) => {
  const mountPath = String(options.mountPath ?? "/plugins/my-plugin");

  return {
    name: "my-plugin",

    // Optional: declare DB tables the plugin needs
    schemaSql: {
      name: "my-plugin-schema",
      sql: [
        `CREATE TABLE IF NOT EXISTS my_plugin_data (
           id TEXT PRIMARY KEY,
           org_id TEXT NOT NULL,
           value TEXT NOT NULL,
           created_at TEXT NOT NULL
         )`,
      ],
    },

    // Subscribe to events, wrap fetch, etc.
    setup(ctx) {
      ctx.bus.subscribe((event) => {
        if (event.type === "message.appended") {
          void ctx.logger(`[my-plugin] new message in ${event.streamId ?? "unknown"}`);
        }
      });
    },

    // Mount HTTP routes
    registerRoutes(ctx) {
      ctx.app.get(mountPath, (c) => c.json({ ok: true }));
    },

    // Called after the HTTP server is bound — use for WebSocket upgrades,
    // port-dependent setup, etc. Capture anything from setup() via closure.
    onServerBound(server) {
      // server is the live http.Server instance
    },
  };
};
```

2. Register it in `src/plugins.ts`:

```typescript
import { myPlugin } from "./plugins/my-plugin.js";

export const builtInPluginFactories: Record<string, PluginFactory> = {
  // ...existing plugins...
  "my-plugin": myPlugin,
};
```

3. Enable it:

```bash
PLUGINS=my-plugin node dist/server.js
```

4. Add an e2e test in `tests/e2e/plugins.test.ts` that exercises the observable
   behavior via the real HTTP app (see `makeHarness` in that file).
