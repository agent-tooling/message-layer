# Next.js Team Client Smoke Tests

This suite validates the most important end-to-end v1 use cases for:

- Better Auth user login and onboarding
- team messaging UX (channels, messages, threads)
- invite-based member onboarding
- attachment upload + artifact message rendering
- Agent Auth discovery/session paths
- message-layer control-plane coverage from UI routes

## Environment setup

1. Start message-layer server from repo root:

```bash
cd /Users/andre.landgraf/Workspaces/personal/agent-tooling/message-layer
bun run dev
```

2. Start Next.js team client:

```bash
cd /Users/andre.landgraf/Workspaces/personal/agent-tooling/message-layer/clients/nextjs-team-client
cp -n .env.local.example .env.local
bun install
bun run dev
```

3. Use agent-browser in a dedicated session:

```bash
agent-browser --session-name ml-team-v1 open http://127.0.0.1:3001
```

## Credentials used by smoke tests

- Primary user: `owner+v1@example.com` / `ownerpass123`
- Invited user: `member+v1@example.com` / `memberpass123`

## Test execution order

Run in this order because later tests depend on data created in earlier ones:

1. `01-auth-and-bootstrap.md`
2. `02-channel-message-thread.md`
3. `03-invite-join-flow.md`
4. `04-attachments.md`
5. `05-agent-onboarding.md`
6. `06-control-plane-sanity.md`

## Completion bar

The suite is complete when:

- all scenarios pass once in the browser,
- no blocking runtime errors appear in app behavior,
- UI remains visually coherent (spacing/hierarchy/buttons/cards),
- each scenario has clear expected outcomes with no ambiguities.
