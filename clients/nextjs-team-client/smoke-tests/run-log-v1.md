# Smoke Run Log (Agent Browser)

Date: 2026-04-20

## Execution summary

All smoke scenarios in this folder were executed once via `agent-browser --session-name ml-team-v1`.

## Results by scenario

- `01-auth-and-bootstrap.md` - pass
  - owner signup succeeded
  - workspace loaded after auth
  - signout/signin cycle succeeded
- `02-channel-message-thread.md` - pass
  - created `frontend-v1`
  - posted message and created thread from message card
- `03-invite-join-flow.md` - pass
  - invite URL generated
  - member blocked before invite acceptance (`invite required before joining this workspace`)
  - member accepted invite and gained workspace access
- `04-attachments.md` - pass
  - attachment uploaded and rendered as `artifact` message part
  - attachment link opened the protected download route
- `05-agent-onboarding.md` - pass
  - discovery endpoint returned agent configuration JSON
  - `/api/team/agent/session` returned unauthorized without bearer token
- `06-control-plane-sanity.md` - pass
  - signed-in API calls loaded channel/member/message state
  - signed-out protected route returned unauthorized

## Issues found and fixed during run

1. Better Auth tables missing (`no such table: user`)
   - fixed by running Better Auth migration.
2. Active channel header could desync after channel creation
   - fixed by making channel refresh set a valid active channel when current is missing.
3. Principal bootstrap race created duplicate actor records under concurrent route requests
   - fixed by adding per-user in-flight principal resolution lock.
4. Non-JSON API error from control-plane read route
   - fixed by restarting message-layer with latest route handlers and adding safer JSON parsing fallback in client transport.

## Visual quality pass

- improved auth card hierarchy and spacing
- improved sidebar panel structure and readability
- improved message card/composer hierarchy
- cleaner action affordances for buttons and inputs
