# Weather agent

A lightweight command agent that registers `/weather-check` and replies in a
thread with both:

- a short text weather summary
- a generative UI `ui` message part (catalog `shadcn`) that renders a weather card

The weather data is deterministic synthetic demo data (city + current hour), so
it works fully local without external weather APIs.

## Prerequisites

1. Run the core server: `pnpm run dev` (repo root).
2. Run the Next.js client: `pnpm run client:nextjs`.
3. Get the org id:
   ```bash
   sqlite3 clients/nextjs/.data/team-client.db \
     "select value from app_settings where key='default_org_id'"
   ```

## Run

```bash
pnpm --dir agents/weather install
pnpm --dir agents/weather start --org-id <orgId>
pnpm --dir agents/weather run once -- --org-id <orgId>
```

Or from repo root:

```bash
pnpm run agent:weather -- --org-id <orgId>
pnpm run agent:weather:once -- --org-id <orgId>
```

## Approval flow

On first boot, approve these in the workspace approval inbox:

1. `command:register` for `/weather-check`
2. `thread:create` when command is invoked in a channel
3. `message:append` on the target thread

## Environment

See `.env.example`.
