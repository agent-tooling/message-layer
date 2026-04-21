# Contributing to message-layer

## Prerequisites

- Node.js ≥ 22
- [pnpm](https://pnpm.io) (pinned in `package.json` → `packageManager`)

No Docker is required to run the default local suite. By default tests run
against a real PGlite database, a real Hono server, and a real WebSocket
server — no mocks of core systems.

## Install

```
pnpm install
```

## Run locally

```
pnpm run dev                    # starts the HTTP + WS server on PORT (default 3000)
pnpm run test                   # full unit + e2e suite
pnpm run test:watch             # watch mode
pnpm run build                  # typecheck + emit to dist/
pnpm run client:terminal        # Pi agent REPL
pnpm run client:terminal:demo   # agent-kernel smoke run (no API keys required)
```

Optional Neon/Postgres e2e:

```
NEON_NEW_E2E=1 pnpm run test -- tests/e2e/postgres-neon.test.ts
```

When `NEON_TEST_DATABASE_URL` is not set, the test provisions a claimable
database from `neon.new` and runs the workflow against the `postgres` adapter.

## Layout

```
src/
  types.ts              Zod schemas + error classes + DomainEvent
  db.ts                 SqlDatabase interface + PGlite adapter + schema
  event-bus.ts          In-process event fan-out
  service.ts            MessageLayer class — the only path into the DB
  http.ts               Hono routes
  ws.ts                 WebSocket subscription transport
  plugins.ts            Plugin runtime + built-in plugins
  config.ts             Env → ServerConfig parsing
  server-runtime.ts     startServer() — composes everything
  server.ts             CLI entry point
  agent-kernel/         Pi coding-agent integration

tests/
  helpers/              Shared harness + HTTP client
  unit/                 Per-function tests against real PGlite
  e2e/                  Full-stack tests across HTTP + WS + plugins
```

## Conventions

- Never bypass `MessageLayer`. HTTP, WS, and the agent kernel all call it;
  plugins consume its `EventBus`. Direct DB access from outside the class
  violates AGENTS.md rule #4.
- Every mutation emits a domain event and appends to the per-org audit log
  inside the same transaction. Do not split those.
- Tests may not mock the DB, the service, or the HTTP app. Use
  `createServiceHarness()` / `startServer()` from the helpers.
- Privacy is enforced in the service layer, not the HTTP layer.
  `assertStreamReadable` is the single source of truth.
- Errors are modeled with `PermissionError`, `ValidationError`,
  `NotFoundError`. The HTTP layer maps them to 403/400/404.

## Adding a plugin

1. Add a factory to `src/plugins.ts` and register it in
   `builtInPluginFactories`.
2. Plugins receive `{ app, service, bus, logger, env, config, wrapFetch }`.
3. Subscribe to events with `ctx.bus.subscribe` or declare an `onEvent`
   handler on the plugin object.
4. Add an e2e test in `tests/e2e/plugins.test.ts`. It must run against the
   real HTTP app and exercise the observable behaviour.

## Adding an endpoint

1. Add the service function with privacy + permission checks.
2. Emit a domain event for every state change.
3. Wire it up in `src/http.ts` with a Zod schema for the request body.
4. Document it in `docs/spec/http-api.md`.
5. Add a unit test (service-level) and an e2e test (HTTP-level).
