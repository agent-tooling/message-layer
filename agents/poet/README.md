# Poet agent

A tiny [Mastra](https://mastra.ai) poet agent that registers a `/poem` slash
command and replies with a poem in a thread when invoked from the Next.js
workspace.

It exists to **exercise the permission flow** end-to-end: on first run the
agent has zero scopes, so joining as an agent and registering `/poem` both
require admin approval in the Next.js workspace UI. Once approved, users can
run `/poem` in a channel and receive the generated poem as a thread reply.

## Prerequisites

1. Run the core server: `pnpm run dev` (from the repo root).
2. Run the Next.js client: `pnpm run client:nextjs`, sign in once so it
   bootstraps the default org.
3. Grab the org id the agent should join:
   ```bash
   sqlite3 clients/nextjs/.data/team-client.db \
     "select value from app_settings where key='default_org_id'"
   ```
4. Export an OpenAI key: `export OPENAI_API_KEY=sk-...`.

## Run

```bash
pnpm --dir agents/poet install                                     # first time
pnpm --dir agents/poet start --org-id <orgId>                      # loop
pnpm --dir agents/poet run once -- --org-id <orgId>                # single tick
```

Or from the repo root (note the `--` so pnpm forwards the flags):

```bash
pnpm run agent:poet -- --org-id <orgId>
pnpm run agent:poet:once -- --org-id <orgId>
```

Any flag can also come from the environment — `MESSAGE_LAYER_ORG_ID`,
`POET_INTERVAL_MS`, `POET_MODEL`, `MESSAGE_LAYER_BASE_URL`,
`NEXTJS_HEALTH_URL`. Run with `--help` for the full list.

## What happens

1. **Health check** `http://localhost:3001/` — if the Next.js app is not
   responding, the loop halts immediately so no OpenAI tokens are burned.
2. **Bootstrap** mints a fresh `agent` actor in the org supplied via
   `--org-id` (or `MESSAGE_LAYER_ORG_ID`) with `actorType="agent"`,
   `displayName="poet-agent"`, and **no** scopes. State is cached in
   `.data/poet-state.json` and reused on later boots when the stored
   actor is still live in the message-layer server.
3. **Register `/poem`** via `POST /v1/commands`, which opens a
   `command:register` request for an admin to approve.
4. **Loop** (every `POET_INTERVAL_MS`, default 60000):
   - Re-check Next.js health. Down → halt.
   - Poll channel subscription events.
   - On `command.invoked` matching `/poem`, create a thread from the invoking
     message and append a generated poem into that thread.

## Approving the agent's requests

After startup, open the Next.js workspace → approval inbox. You'll see at
least the `/poem` registration request:

- `command:register` on `org:<orgId>`

Depending on your grant model, you may also need to approve `thread:create`
or `message:append` requests the first time the agent attempts a reply.

## Environment

See `.env.example`. The defaults assume the local dev servers on the
standard ports.

## Troubleshooting

- **`missing org id`** → Pass `--org-id <id>` or set
  `MESSAGE_LAYER_ORG_ID`. Look up the current default org via the
  sqlite query at the top of this file.
- **`org <id> not found`** → The core server restarted and wiped its
  in-memory catalog. Re-open the Next.js app so it recreates the org,
  then re-run the poet with the fresh id. The agent's cached actor is
  also staleness-checked on every boot, so no extra cleanup is needed.
- **`Incorrect API key provided`** → Mastra logs the full upstream error
  before the agent catches it. Set a real `OPENAI_API_KEY` and the noise
  disappears.

## Why the Next.js health gate?

The loop exists to demonstrate the permission flow, which requires a
human approver. If the app is down there is nobody to approve and no
audit UI to watch — so there is no point in paying OpenAI for tokens.
The gate cuts the loop cleanly on failure.
