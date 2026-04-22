# Cursor agent

Runtime daemon that behaves like a lightweight "Cursor app" worker:

- joins a workspace as an `agent` actor (admin-approved join request flow)
- subscribes to visible channels and detects invocation messages posted by the
  Next.js client (`cursor.invoke` context in message text part metadata)
- posts an acknowledgement in the target thread stream

This is the first implementation pass of the demo runtime. It keeps behavior
deterministic and local-dev friendly while the richer tool/kernel execution
loop evolves.

## Run

```bash
pnpm --dir agents/cursor install
pnpm --dir agents/cursor start --org-id <orgId>
pnpm --dir agents/cursor run once -- --org-id <orgId>
```

Or from repository root:

```bash
pnpm run agent:cursor -- --org-id <orgId>
pnpm run agent:cursor:once -- --org-id <orgId>
```

## Environment

See `.env.example`.

Required:

- `MESSAGE_LAYER_ORG_ID` (or `--org-id`)

Optional:

- `MESSAGE_LAYER_BASE_URL` (default `http://127.0.0.1:3000`)
- `NEXTJS_HEALTH_URL` (default `http://localhost:3001`)
- `CURSOR_AGENT_DISPLAY_NAME` (default `cursor-agent`)
