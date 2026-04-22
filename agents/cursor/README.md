# Cursor agent

A message-layer daemon that bridges `cursor.invoke` tool calls posted by the Next.js client into real [Cursor Cloud Agents](https://cursor.com/docs/cloud-agent/api/endpoints). Think of it as the Cursor equivalent of a Slack bot integration — it listens on channels for invocations, launches cloud agents, and posts results (including PR links and summaries) back into the thread.

## How it works

1. The Next.js client posts a message containing a `cursor.invoke` tool call part to a channel.
2. This daemon detects the invocation over WebSocket, extracts the prompt and repository info.
3. It launches a real Cursor cloud agent via `POST https://api.cursor.com/v0/agents`.
4. It posts an acknowledgement with the agent link into the target thread.
5. It polls the agent status until it reaches a terminal state (`FINISHED`, `FAILED`, or `STOPPED`).
6. It posts the final summary (and PR link if one was created) back into the thread.

### Invocation message format

The Next.js client sends a message with a `tool_call` part:

```json
{
  "type": "tool_call",
  "payload": {
    "toolName": "cursor.invoke",
    "args": {
      "runId": "unique-run-id",
      "prompt": "Add a README with installation instructions",
      "streamType": "thread",
      "threadId": "thread_abc123",
      "requesterActorId": "actor_xyz",
      "repository": "https://github.com/your-org/your-repo",
      "ref": "main"
    }
  }
}
```

`repository` and `ref` are optional — they fall back to `CURSOR_DEFAULT_REPOSITORY` and `CURSOR_DEFAULT_REF` if omitted.

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
