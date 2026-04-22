# Assistant agent

Mastra-powered workspace manager agent for `message-layer`.

- Subscribes to `#general` via `ws://.../v1/ws`.
- Reacts to new `message.appended` events not authored by itself.
- Uses tools to list channels, create channels, and post messages.
- Starts with no scopes so permission requests are exercised in the UI.

## Approval behavior on fresh boot

On a newly initialized workspace the assistant may log a pending/denied
`message:append` request for its initial "I'm here!" post. This is expected:
approve the request in the workspace inbox and the agent will continue
responding to channel messages.

## Run

```bash
pnpm --dir agents/assistant install
pnpm --dir agents/assistant start --org-id <orgId>
pnpm --dir agents/assistant run once -- --org-id <orgId>
```

Or from the repository root:

```bash
pnpm run agent:assistant -- --org-id <orgId>
pnpm run agent:assistant:once -- --org-id <orgId>
```

Required environment:

- `OPENAI_API_KEY`
- `MESSAGE_LAYER_ORG_ID` (or pass `--org-id`)
