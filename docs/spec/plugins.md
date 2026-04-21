# Plugins

message-layer's plugin system extends the server with additional routes, event
handlers, and schema migrations without modifying core. The core service only
handles orgs, actors, channels, threads, messages, grants, permission requests,
artifacts, cursors, clients, and audit. Everything else is a plugin.

---

## Configuration

### Typed subpath imports (recommended)

Each plugin is a standalone subpath export with a typed factory function:

```typescript
import { startServer } from "message-layer";
import { requestLoggingPlugin } from "message-layer/plugins/request-logging";
import { healthMetaPlugin }     from "message-layer/plugins/health-meta";
import { apiKeyAuthPlugin }     from "message-layer/plugins/api-key-auth";
import { eventLoggerPlugin }    from "message-layer/plugins/event-logger";
import { webhookPlugin }        from "message-layer/plugins/webhooks";
import { websocketPlugin }      from "message-layer/plugins/websocket";
import { scopedKnowledgePlugin }from "message-layer/plugins/scoped-knowledge";
import { durableStreamsPlugin }  from "message-layer/plugins/durable-streams";
import { inMemoryKnowledgePlugin } from "message-layer/plugins/in-memory-knowledge";

await startServer({
  plugins: [
    requestLoggingPlugin({ prefix: "[app]" }),
    healthMetaPlugin({ version: "2.0.0" }),
    apiKeyAuthPlugin({ strict: true }),
    websocketPlugin(),
  ],
});
```

Plugins can be passed either as already-instantiated objects (as above) or as
`{ name, options }` descriptors. Both forms can be mixed in the same array.

### Via environment variable (for process-level config)

```bash
PLUGINS=request-logging,websocket,webhooks node dist/server.js
```

### Via `MESSAGE_LAYER_CONFIG` JSON

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

### `scoped-knowledge`

Persists message-derived knowledge entries per stream. Every `message.appended`
event is indexed; entries snapshot their source stream's visibility so derived
data can never be retroactively widened.

**Routes added:**

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/knowledge?streamId=…` | List knowledge entries for a stream. |
| `GET` | `/v1/knowledge/:entryId` | Fetch a single entry. |
| `POST` | `/v1/knowledge/:entryId/promote` | Promote an entry org-wide (requires `knowledge:promote`). |

See [http-api.md](./http-api.md) for full request/response shapes.

---

### `websocket`

Attaches a WebSocket server to the HTTP server after it is bound to a port.
This is the recommended way to enable WebSocket: using the plugin makes WS
an explicit, opt-in dependency instead of a hidden flag.

| Option | Type | Default | Description |
|---|---|---|---|
| `path` | `string` | `"/v1/ws"` | WebSocket endpoint path. |

```typescript
import { websocketPlugin } from "message-layer/plugins/websocket";

await startServer({
  plugins: [websocketPlugin()],
  config: { websocket: false }, // disable the legacy flag; plugin takes over
});
```

**Backward compat:** the `ENABLE_WEBSOCKET=true` environment variable and the
`websocket: true` config flag still work when no `websocket` plugin is present.
When the plugin IS present, the config flag is ignored.

**String name (env-var config):** `"websocket"` (e.g. `PLUGINS=websocket`).

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

### `in-memory-knowledge` _(legacy)_

A lightweight in-memory index of message IDs per stream, built from
`message.appended` events. Retained for plugin-authoring tests and backward
compatibility. Use `scoped-knowledge` for production — it persists across
restarts, enforces privacy, and supports promotion.

---

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
