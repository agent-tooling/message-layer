# 05 Agent Onboarding

## Goal

Validate external-agent discovery and agent-session API path exposure from the web client.

## Steps

1. While signed in as owner, confirm Agent onboarding panel is visible.
2. Open `http://127.0.0.1:3001/.well-known/agent-configuration` in browser.
3. Confirm discovery payload returns successfully (JSON page).
4. Open `http://127.0.0.1:3001/api/team/agent/session` without bearer token.
5. Confirm unauthorized response.
6. Return to workspace and verify no regressions after these checks.

## Expected results

- Agent onboarding information is visible in the app UI.
- Discovery endpoint is reachable and not 404.
- Session endpoint correctly enforces auth for missing token.

## Notes

- This smoke test validates onboarding surface and guardrails.
- Full third-party agent registration flow can be added as a follow-up scripted harness.
