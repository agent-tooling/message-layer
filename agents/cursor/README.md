# Cursor agent

A message-layer agent that turns [Cursor Cloud Agent](https://cursor.com/docs/cloud-agent/api/endpoints) runs into a first-class workspace citizen. It has no bespoke UI — humans invoke it exactly like any other agent in the org, via a registered slash command or an `@`-mention.

## How it works

1. **On boot**, the agent joins the org as an `agent` actor and registers a `/cursor` slash command via `POST /v1/commands`. An admin approves the registration through the Next.js admin UI (same lifecycle as any other slash command in message-layer).
2. **On every message-layer event** streamed over the `/v1/ws` WebSocket, the agent watches for two triggers:
   - `command.invoked` where the command resolves to `/cursor` owned by this actor
   - `mention.recorded` where `mentionedActorId` is this actor
3. When either fires, the agent builds a prompt, creates a public thread anchored on the source message (or reuses the existing one if the invocation was already in a thread), and launches a Cursor cloud agent via `POST https://api.cursor.com/v0/agents`.
4. It posts an acknowledgement (with a link to the cloud-agent dashboard) into the thread, polls to terminal state, and posts the final summary (plus PR link when one was created) back into the thread.

### Invocation shapes

#### Slash command

```
/cursor text="Add a README with installation instructions" repository="https://github.com/your-org/your-repo" ref="main"
```

Only `text` is required. `repository` and `ref` fall back to `CURSOR_DEFAULT_REPOSITORY` / `CURSOR_DEFAULT_REF`.

#### Mention

```
@cursor-agent please add CI for the Next.js client
```

The agent takes the full message text as the prompt; repository/ref always come from env defaults for the mention path.

## Approval flow notes

On a fresh workspace, first run commonly requires multiple approvals:

1. agent join request (admin -> agents)
2. `command:register` for `/cursor`
3. `thread:create` when handling a channel-scoped invocation
4. `message:append` on target thread(s), depending on grant policy

If `/cursor` or `@cursor-agent` appears to do nothing, check the approval inbox
for pending requests before troubleshooting the daemon.

## Run

```bash
pnpm --dir agents/cursor install
pnpm --dir agents/cursor start --org-id <orgId>
pnpm --dir agents/cursor run once -- --org-id <orgId>
```

Or from the repository root:

```bash
pnpm run agent:cursor -- --org-id <orgId>
pnpm run agent:cursor:once -- --org-id <orgId>
```

## Environment

Copy `.env.example` to `.env` and fill in the values.

| Variable | Required | Default | Description |
|---|---|---|---|
| `CURSOR_API_KEY` | **yes** | — | Cursor API key from [cursor.com/settings](https://cursor.com/settings) |
| `MESSAGE_LAYER_ORG_ID` | **yes** | — | message-layer org ID (or pass `--org-id`) |
| `CURSOR_DEFAULT_REPOSITORY` | **yes** (if not per-call) | — | GitHub repo URL agents run against |
| `MESSAGE_LAYER_BASE_URL` | no | `http://127.0.0.1:3000` | message-layer server |
| `NEXTJS_HEALTH_URL` | no | `http://localhost:3001` | Next.js client (for workspace bootstrap) |
| `CURSOR_DEFAULT_REF` | no | `main` | Default git ref |
| `CURSOR_AGENT_DISPLAY_NAME` | no | `cursor-agent` | Display name in the workspace |

## Cursor API client

`src/cursor-api.ts` is a typed, standalone client for the full [Cursor Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints):

| Method | Endpoint |
|---|---|
| `getMe()` | `GET /v0/me` |
| `listModels()` | `GET /v0/models` |
| `listRepositories()` | `GET /v0/repositories` |
| `listAgents(opts?)` | `GET /v0/agents` |
| `getAgent(id)` | `GET /v0/agents/:id` |
| `getConversation(id)` | `GET /v0/agents/:id/conversation` |
| `getArtifacts(id)` | `GET /v0/agents/:id/artifacts` |
| `downloadArtifact(id, path)` | `GET /v0/agents/:id/artifacts/download` |
| `launchAgent(opts)` | `POST /v0/agents` |
| `addFollowup(id, prompt)` | `POST /v0/agents/:id/followup` |
| `stopAgent(id)` | `POST /v0/agents/:id/stop` |
| `deleteAgent(id)` | `DELETE /v0/agents/:id` |
| `waitForTerminal(id, opts?)` | polls `getAgent` until `FINISHED`/`FAILED`/`STOPPED` |
