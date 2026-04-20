# message-layer

A headless messaging layer for humans, agents, and apps — with Pi coding agent as the first-class runtime.

## v1 TypeScript core

This repository includes a local-first TypeScript implementation of the v1 messaging core:

- orgs, actors, memberships, channels, threads
- append-only structured messages with ordered message parts
- per-stream monotonic ordering via `streamSeq`
- idempotent appends keyed by `(orgId, streamId, actorId, idempotencyKey)`
- grant-based authorization + permission request flow
- cursor updates and client registration
- event replay from stream cursor
- append-only audit log with hash chaining

## Agent kernel

`src/agent-kernel/` integrates Pi (`@mariozechner/pi-coding-agent`) in-process as an agent runtime:

- `AgentKernel` owns a Pi `AgentSession` and persists every turn as message-layer parts (`text`, `tool_call`, `tool_result`, `approval_request`, `approval_response`).
- Tool execution goes through a **permission gate**: if the agent actor lacks a `tool:execute:<toolName>` grant, a permission request is created and the tool call is suspended until a human approves or denies via the API or either client.
- Idempotent appends via Pi event timestamps keep the stream consistent.

## Stack

- Node.js + TypeScript
- Hono HTTP server
- PGlite local PostgreSQL adapter
- Zod validation
- Vitest end-to-end tests (no mocks)
- Pi coding agent SDK (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`)

## Run locally

Install dependencies:

```
bun install
```

Run tests:

```
bun run test
```

Start the server:

```
bun run dev
```

## Terminal client (Pi agent REPL)

The terminal client wraps Pi in an interactive agent REPL powered by message-layer:

```
bun run client:terminal
```

### Quick start

```
> init                        # create org, actors, channel and start Pi
> What files are in the cwd?  # send prompt — output streams live
> model list                  # see available models
> model set anthropic/claude-opus-4-5
> pending                     # list pending tool approval requests
> approve <requestId>         # approve a tool call
> deny <requestId>            # deny a tool call
> steer stop and do X instead
> messages 20                 # tail the last 20 stream entries
> --raw                       # switch to low-level API REPL
```

### API keys

Pi reads provider API keys from `~/.pi/agent/auth.json` or environment variables (e.g. `ANTHROPIC_API_KEY`). See [pi-mono docs/providers.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md) for setup.

## Next.js example client

A browser UI for the message-layer + Pi agent stack:

```
bun run client:nextjs       # starts on http://localhost:3000
```

Features:
- Chat view with colour-coded message parts (text, tool_call, tool_result, approval_request/response)
- Approval inbox with one-click allow/deny
- Model selector backed by Pi's `ModelRegistry` (server-side, no API key exposure)
- Live 1.5 s poll for new messages and pending approvals

### Setup

```
cd clients/nextjs
cp .env.local.example .env.local
# fill in MESSAGE_LAYER_* values after running `init` in the terminal client
bun run dev
```

## HTTP API

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | liveness check |
| POST | /v1/orgs | create org |
| POST | /v1/actors | create actor |
| POST | /v1/channels | create channel |
| POST | /v1/threads | create thread |
| POST | /v1/messages | append message |
| GET | /v1/streams/:id/messages | list messages |
| GET | /v1/streams/:id/subscribe | replay events |
| POST | /v1/cursors | update cursor |
| POST | /v1/grants | create grant |
| POST | /v1/grants/:id/revoke | revoke grant |
| GET | /v1/grants/check | check if actor has capability |
| POST | /v1/permission-requests | create permission request |
| GET | /v1/permission-requests | list open permission requests |
| POST | /v1/permission-requests/:id/resolve | approve or deny |
| POST | /v1/clients | register client |

Server endpoint: `GET /health`
