# nextjs

Team + agents reference web client for `message-layer`, acting as the proof-of-concept control-plane UI.

## What this showcases

- Better Auth email/password login with session persistence
- Invite-link onboarding for teammates (first user bootstraps the workspace)
- Channels, threads, messages, and live polling for new activity
- Rich message-part rendering: text, tool_call, tool_result, approval_request, approval_response, artifact attachments
- Attachment upload/download with local dev storage (`AttachmentStore` interface pluggable for S3 later)
- Agent Auth discovery document + protected session endpoint so external coding agents can onboard
- In-app approval inbox for permission requests so humans can allow/deny agent tool calls in real time

## Setup

Run the `message-layer` server first (from the repository root):

```bash
bun install
bun run dev
```

Then run the web client:

```bash
cd clients/nextjs
cp -n .env.local.example .env.local
bun install
bun run dev
```

The app serves on `http://localhost:3001`.

### First-time Better Auth database

The auth schema is managed by Better Auth. The first time you run the client, apply migrations:

```bash
cd clients/nextjs
bunx @better-auth/cli migrate --config ./lib/auth.ts --yes
```

## Agent onboarding surface

- Discovery document: `GET /.well-known/agent-configuration`
- Auth handler base: `/api/auth/[...all]`
- Protected session probe: `GET /api/team/agent/session` (returns `401` without a valid agent bearer token)

External agents obtain tokens through the Agent Auth flow exposed by Better Auth, then call the scoped message-layer operations through this app's routes.

## Runtime notes

- Single default org per instance. Non-first users must accept an invite to join.
- Attachments live on disk under `.data/attachments/`. The `lib/attachment-store.ts` interface allows swapping in S3/presigned uploads.
- Local app state (user→actor map, invites, attachments metadata) lives in `.data/team-client.db` (SQLite).
- Better Auth schema lives in `.data/better-auth.db` (SQLite).
