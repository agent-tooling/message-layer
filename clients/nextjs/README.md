# message-layer × pi — Next.js example client

A browser UI for the message-layer + Pi coding agent stack.

## Features

- **Chat view** — renders all message part types: `text`, `tool_call`, `tool_result`, `approval_request`, `approval_response`
- **Approval inbox** — one-click allow/deny for tool calls waiting on human confirmation
- **Model selector** — lists available models via Pi's `ModelRegistry` (server-side, API keys never reach the browser)
- **Live polling** — 1.5 s refresh for new messages and pending approvals

## Quick start

1. Start the message-layer server from the repo root:
   ```
   bun run dev
   ```

2. In the terminal client, run `init` to create an org, actors, and channel:
   ```
   bun run client:terminal
   > init
   # copy the org/actor/channel IDs printed in output
   ```

3. Configure this app:
   ```
   cp .env.local.example .env.local
   # fill in MESSAGE_LAYER_* values from step 2
   ```

4. Start the Next.js dev server:
   ```
   bun run dev        # (from this directory)
   # or from repo root:
   bun run client:nextjs
   ```

5. Open [http://localhost:3000](http://localhost:3000)

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `NEXT_PUBLIC_MESSAGE_LAYER_URL` | message-layer server URL | `http://127.0.0.1:3000` |
| `MESSAGE_LAYER_ORG_ID` | org to connect to | `dev-org` |
| `MESSAGE_LAYER_ACTOR_ID` | human actor (you) | `dev-actor` |
| `MESSAGE_LAYER_AGENT_ACTOR_ID` | agent actor id | |
| `MESSAGE_LAYER_CHANNEL_ID` | channel to display | |
| `MESSAGE_LAYER_SCOPES` | principal scopes | `channel:create,message:append,grant:create` |

## API routes

- `GET /api/agent/models` — list available Pi models (requires API keys in `~/.pi/agent/auth.json`)
- `POST /api/agent/models` — set active model `{ modelId: "provider/id" }`
