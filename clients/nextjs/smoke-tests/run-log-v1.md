# Smoke Run Log (Agent Browser)

Date: 2026-04-20

## Execution summary

All seven smoke scenarios in this folder were executed once via
`agent-browser --session-name ml-team-v1` against a freshly reset local
stack (`.data/better-auth.db` and `.data/team-client.db` deleted before the
run, Better Auth migration re-applied, message-layer and Next.js client
started in parallel).

## Results by scenario

- `01-auth-and-bootstrap.md` — pass
  - owner signup transitioned straight into the workspace UI
  - session persisted across full-page reload
  - sign-out returned to the auth panel; sign-in as the same user restored
    the workspace
- `02-channel-message-thread.md` — pass
  - `frontend-v1` channel created and became active
  - `Kickoff thread smoke test` message posted, thread spawned from the
    message card, footer shows `1 thread in channel`
- `03-invite-join-flow.md` — pass
  - invite URL generated for `member+v1@example.com`
  - second account signup blocked with
    `invite required before joining this workspace`
  - invite acceptance allowed the member to load the workspace
- `04-attachments.md` — pass
  - local text file uploaded, rendered as an artifact part, and downloaded
    via `/api/team/attachments/:id`
- `05-agent-onboarding.md` — pass
  - `/.well-known/agent-configuration` returned the JSON descriptor
  - `/api/team/agent/session` returned `401 unauthorized` without a bearer
    token
- `06-control-plane-sanity.md` — pass
  - signed-in API calls (`channels`, `members`, channel messages) all
    returned 200
  - after sign-out, the same endpoints returned 401
  - a new message was visible on the next polling tick (~2s)
- `07-agent-approval-inbox.md` — pass
  - an agent actor and a permission request were injected directly against
    the message-layer HTTP API
  - the approval banner appeared within one polling cycle
  - `Allow` and `Deny` both cleared the row and returned the banner to 0

## Issues found and fixed during run

1. Next.js 16 dev server blocked cross-origin dev resources when the app
   was opened via `http://127.0.0.1:3001` (the URL documented in the
   smoke-test README). The HMR client chunks and `/__nextjs_font/*` assets
   returned 403 and React never hydrated, leaving the page stuck on
   `Loading session...`.
   - fixed by adding `allowedDevOrigins: ["127.0.0.1", "localhost"]` to
     `clients/nextjs/next.config.ts`.
2. Better Auth rejected POSTs (`sign-out`, etc.) from `127.0.0.1:3001`
   with `403 "Invalid origin"` because its CSRF check only trusts the
   configured `baseURL`.
   - fixed by adding both `localhost:3001` and `127.0.0.1:3001` to
     `trustedOrigins` in `clients/nextjs/lib/auth.ts`.
3. Principal bootstrap race re-emerged under Next.js 16 / Turbopack: each
   route handler chunk received its own copy of `lib/message-layer`, so
   the module-scoped in-flight Map was not shared across handlers. Ten
   parallel `/api/team/bootstrap` calls on a fresh account created up to
   ten actor rows in message-layer while only one was mapped in
   `user_actor_map`.
   - fixed by hoisting `inFlightPrincipalResolutions` onto `globalThis`
     so every module instance shares the same lock table, and by
     re-checking `getUserActorMap` inside the pending promise to defend
     against any remaining race. The stress test (10 parallel bootstrap
     requests on a fresh user) now produces a single actor row.

## Visual quality pass

- Sign-in, invite accept, and workspace pages render cleanly without
  layout overlap.
- Sidebar sections (Channels / People / Invite / Agents) are visually
  distinct; composer + message cards remain legible.
- Approval banner uses amber accent and prominent Allow/Deny controls.
