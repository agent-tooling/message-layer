# Contributing to message-layer

## Prerequisites

- Node.js ≥ 22
- [pnpm](https://pnpm.io) (pinned in `package.json` → `packageManager`)

No Docker is required for the default local suite. Tests run against a real PGlite database, a real Hono server, and a real WebSocket server — no mocks of core systems.

## Install

```bash
pnpm install
```

## Development commands

```bash
pnpm run dev                    # HTTP + WS server on http://localhost:3000
pnpm run test                   # full unit + e2e suite (no mocks)
pnpm run test:watch             # watch mode
pnpm run build                  # typecheck + emit to dist/ (includes .d.ts)
pnpm run demo:hero              # narrated in-process end-to-end demo

# Clients
pnpm run client:terminal        # interactive terminal REPL
pnpm run client:terminal:demo   # agent-kernel smoke run (no API keys required)
pnpm run client:nextjs          # Next.js web client on http://localhost:3001

# Agents (require .env in agents/<name>/)
pnpm run agent:poet             # Pi poet agent daemon
pnpm run agent:assistant        # Pi assistant agent daemon
```

### Optional Postgres e2e

```bash
NEON_NEW_E2E=1 pnpm run test -- tests/e2e/postgres-neon.test.ts
```

When `NEON_TEST_DATABASE_URL` is not set, the test provisions a claimable database from `neon.new`.

## Publishing to npm

The package is ready to publish. The build step runs automatically via `prepublishOnly`:

```bash
npm publish --access public
```

Before publishing, check that the name is available:
```bash
npm info message-layer
```

## Repository layout

```
src/
  types.ts              Zod schemas, error classes, DomainEvent
  db.ts                 SqlDatabase interface + PGlite adapter + schema
  event-bus.ts          In-process event fan-out
  service.ts            MessageLayer class — the only path into the DB
  http.ts               Hono HTTP routes
  ws.ts                 WebSocket subscription transport
  plugins.ts            Plugin runtime + all built-in plugin factories
  plugins/              Individual plugin implementations
    memory.ts
    search.ts
    webhooks.ts
    durable-streams.ts
    durable-streams-storage.ts
  config.ts             Env → ServerConfig parsing
  server-runtime.ts     startServer() — composes DB, service, HTTP, WS, plugins
  server.ts             CLI entry point
  sdk/                  HTTP client SDK (exported as message-layer/sdk)
  agent-kernel/         Pi coding-agent integration (exported as message-layer/agent-kernel)

tests/
  helpers/              Shared harness (createServiceHarness, startServer)
  unit/                 Per-function tests against real PGlite
  e2e/                  Full-stack tests across HTTP + WS + plugins

clients/
  terminal/             Interactive REPL and smoke-test runner
  nextjs/               Full web client (Better Auth, invites, attachments, approval inbox)
    components/genui/   Generative UI renderer — catalog, registry, GenuiPartView
    app/genui-demo/     Standalone demo page (no auth) at /genui-demo

agents/
  poet/                 Example Pi poet agent
  assistant/            Example Pi assistant agent

docs/
  spec/                 HTTP API spec, authentication, hero-flow narrative
```

## Conventions

- **Never bypass `MessageLayer`.** HTTP, WS, the SDK, and the agent kernel all go through it. Plugins consume its `EventBus`. Direct DB access outside the class violates AGENTS.md rule #4.
- **Every mutation emits a domain event** and appends to the per-org audit log inside the same transaction. Do not split those.
- **Tests may not mock the DB, service, or HTTP app.** Use `createServiceHarness()` / `startServer()` from the helpers.
- **Privacy is enforced in the service layer**, not the HTTP layer. `assertStreamReadable` is the single source of truth.
- **Errors are typed:** `PermissionError`, `ValidationError`, `NotFoundError`. The HTTP layer maps them to 403/400/404.

## Adding a plugin

1. Create a factory function `(options?) => ServerPlugin` in `src/plugins/your-plugin.ts`.
2. Import and register it in `builtInPluginFactories` in `src/plugins.ts`.
3. Plugins receive `{ app, db, service, bus, logger, env, config, wrapFetch }` in `setup` and `registerRoutes`.
4. Subscribe to events via `ctx.bus.subscribe` or implement `onEvent` on the plugin object.
5. Add schema migrations to `plugin.schemaSql` if your plugin needs DB tables.
6. Add an e2e test in `tests/e2e/plugins.test.ts` that runs against the real HTTP app.

## Adding a service method + endpoint

1. Add the service method to `MessageLayer` in `src/service.ts` with privacy and permission checks.
2. Emit a `DomainEvent` for every state change (inside the same DB transaction as the write).
3. Wire up a Hono route in `src/http.ts` with a Zod schema for the request body.
4. Add the endpoint to the HTTP API table in `README.md` and `docs/spec/http-api.md`.
5. Add a unit test (service-level against PGlite) and an e2e test (HTTP-level).

## Adding a public SDK method

If you add a new HTTP endpoint that should be accessible from the SDK:

1. Add the method to `MessageLayerClient` in `src/sdk/index.ts`.
2. Export any new public types from the same file.
3. Rebuild: `pnpm run build`.
