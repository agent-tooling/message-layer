# Terminal client

Two modes backed by the message-layer v1 HTTP and WebSocket transports.

- **Agent mode** (default): Pi coding agent driven through the in-process
  `AgentKernel`. Supports prompt / steer / follow-up, model selection, tool
  approval inbox, and a message tail.
- **Raw mode** (`--raw` or `raw`): a low-level REPL that maps 1:1 to HTTP
  endpoints plus a WebSocket subscriber. Useful for exercising the server
  without writing any other client.

## Run

Start the server first:

```
pnpm run dev
```

Then launch the terminal UI:

```
pnpm run client:terminal
```

Optional env vars:

- `MESSAGE_LAYER_BASE_URL` (default `http://127.0.0.1:3000`) — also used to
  derive the WebSocket URL.

## Raw mode commands

```
set-base <url>
set-principal <actorId> <orgId> [scope1,scope2]

create-org <name>
create-actor <orgId> <human|agent|app> <displayName>
create-channel <name> [private|public]
channel-add-member <channelId> <actorId> [role]
channel-remove-member <channelId> <actorId>
channel-members <channelId>

grant <actorId> <resourceType> <resourceId|none> <capability>
revoke <grantId>
grant-check <actorId> <capability>

post <streamId> <channel|thread> <text> [--auto-request]
redact <messageId> [reason]
list <streamId> [afterSeq] [limit]
subscribe <streamId> [fromSeq]          HTTP replay
ws-subscribe <streamId> [fromSeq]       live WebSocket push (Ctrl+C to stop)

create-thread <channelId> <parentMessageId>

request-permission <action> <resourceType> <resourceId|none>
resolve-permission <requestId> <approve:true|false> [notes]
list-permissions [actorId]

update-cursor <streamId> <lastSeenSeq> <lastAckSeq>
get-cursor <streamId>
register-client <endpoint>

audit-rows
audit-verify
```

`--auto-request` on `post` enables `autoRequestOnDeny`: if the caller lacks
the `message:append` capability the server opens a permission request and
returns `{ denied, requestId, capability, ... }` instead of `403`.

## Smoke mode

`pnpm run client:terminal:demo` runs the client with `--smoke`. It exits
immediately after printing `terminal-client-smoke-ok` and is wired into the
Vitest e2e suite.
