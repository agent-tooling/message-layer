# Poet agent

A tiny [Mastra](https://mastra.ai) agent that, once a minute, writes a short
poem and posts it into `#poems` on the local message-layer instance.

It exists to **exercise the permission flow** end-to-end: on first run the
agent has zero scopes, so creating `#poems` and posting into it both
return `{ denied, permissionRequestId }`. A human approves those requests
in the Next.js workspace UI, and on the next tick the agent succeeds.

## Prerequisites

1. Run the core server: `pnpm run dev` (from the repo root)
2. Run the Next.js client: `pnpm run client:nextjs`, sign in once so it
   bootstraps the default org.
3. Export an OpenAI key: `export OPENAI_API_KEY=sk-...`

## Run

```bash
pnpm --dir agents/poet install          # first time only
pnpm --dir agents/poet start            # loop forever, one tick per POET_INTERVAL_MS
pnpm --dir agents/poet run once         # run a single tick and exit
```

Or from the repo root:

```bash
pnpm run agent:poet                     # loop
pnpm run agent:poet:once                # single tick
```

## What happens

1. **Health check** `http://localhost:3001/` — if the Next.js app is not
   responding, the loop halts immediately so no OpenAI tokens are burned.
2. **Bootstrap** reads `default_org_id` from the Next.js
   `team-client.db` and mints a fresh `agent` actor in that org
   (`actorType="agent"`, `displayName="poet-agent"`) with **no** scopes.
   State is cached in `.data/poet-state.json`.
3. **Loop** (every `POET_INTERVAL_MS`, default 60000):
   - Re-check Next.js health. Down → halt.
   - `agent.generate(...)` with three tools available:
     - `list_channels`  — discover channels.
     - `create_channel` — attempt to create by name; surfaces the
       permission request id on deny.
     - `post_message`   — resolves name → id, posts, surfaces the
       permission request id on deny (via `autoRequestOnDeny: true`).
   - Every tool call, tool result, and the final model text is logged
     to the terminal with timestamps.

## Approving the agent's requests

After the first denied tick, open the Next.js workspace → approval inbox.
You'll see two pending requests:

- `channel:create` on `org:<orgId>`
- `message:append` on `channel:<poems-channel-id>` (only after `#poems` exists)

Approve both. The agent's next tick will succeed and a poem will land in
`#poems`.

## Environment

See `.env.example`. The defaults assume the local dev servers on the
standard ports.

## Troubleshooting

- **`cannot find default_org_id`** → The Next.js client hasn't bootstrapped
  an org yet. Open http://localhost:3001 and sign in once.
- **`actor is not in org` on boot** → The message-layer server restarted
  and wiped its PGlite memory, so the cached actor is gone. Delete
  `.data/poet-state.json` (or the `actorIsLive` check will do it for you
  on next boot).
- **`Incorrect API key provided`** → Mastra logs the full upstream error
  before the agent catches it. Set a real `OPENAI_API_KEY` and the noise
  disappears.

## Why the Next.js health gate?

The loop exists to demonstrate the permission flow, which requires a
human approver. If the app is down there is nobody to approve and no
audit UI to watch — so there is no point in paying OpenAI for tokens.
The gate cuts the loop cleanly on failure.
