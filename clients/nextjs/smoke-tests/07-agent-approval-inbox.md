# 07 Agent Approval Inbox

## Goal

Validate that the approval inbox surfaces pending permission requests from agents and that an admin can resolve them inline.

## Steps

1. Sign in as `owner+v1@example.com`.
2. From a separate shell, simulate an agent permission request (replace `<ORG_ID>` and `<AGENT_ACTOR_ID>` with values from the owner's workspace; a quick path is to call the terminal client or to create an agent actor via message-layer directly and post a permission request on its behalf):

```bash
curl -sS -X POST "http://127.0.0.1:3000/v1/permission-requests" \
  -H "content-type: application/json" \
  -H "x-principal: {\"actorId\":\"<AGENT_ACTOR_ID>\",\"orgId\":\"<ORG_ID>\",\"scopes\":[],\"provider\":\"smoke-test\"}" \
  -d '{"action":"tool:execute:filesystem.read","resourceType":"tool","resourceId":"filesystem.read"}'
```

3. Within ~2 seconds the Next.js workspace should display a banner: `N approvals pending` and an inbox row with `Allow` / `Deny` buttons.
4. Click `Allow` on the pending row.
5. Confirm the row disappears and the pending counter updates.
6. Repeat with another simulated request and click `Deny` to verify the alternate path.

## Expected results

- Approval entries surface the requesting agent's display name (when known) and the capability they requested.
- `Allow` mints a grant through message-layer; the resolved request stops reappearing.
- `Deny` closes the request without granting capability.

## UI quality checks

- Banner is prominent but not overwhelming.
- Allow/Deny buttons are clearly differentiated by color.
- Rows remain legible when actor ids are long.
