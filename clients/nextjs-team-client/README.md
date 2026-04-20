# nextjs-team-client

Team-first Next.js example client for `message-layer` as a control plane.

## Features

- Better Auth session-based login
- Invite-link onboarding flow (`/invite/accept`)
- Team chat UX with channels, threads, and message composer
- Local attachment upload/download with `artifact` message parts
- Agent Auth discovery and runtime verification endpoints

## Setup

```bash
cd clients/nextjs-team-client
bun install
cp .env.local.example .env.local
```

Run the `message-layer` server first (from repository root):

```bash
bun run dev
```

Then run the client:

```bash
bun run client:nextjs-team
```

## Agent onboarding

- Discovery document: `/.well-known/agent-configuration`
- Auth handler base: `/api/auth/[...all]`
- Example protected route for agent JWT validation: `/api/team/agent/session`

## Notes

- This example intentionally uses one default org for v1.
- Attachment storage is local filesystem under `.data/attachments`.
- The storage interface is abstracted in `lib/attachment-store.ts` so S3/presigned uploads can replace it later.
