# 03 Invite Join Flow

## Goal

Validate invite-link generation and join gating for non-first users.

## Steps

1. Sign in as owner (`owner+v1@example.com`).
2. In invite panel, generate invite for `member+v1@example.com`.
3. Copy generated invite URL.
4. Sign out.
5. Create second account:
   - email: `member+v1@example.com`
   - password: `memberpass123`
   - name: `Member V1`
6. Confirm user cannot bootstrap workspace automatically before accepting invite.
7. Open copied invite URL and click `Accept invite`.
8. Navigate back to home page and verify workspace loads.
9. Confirm member appears in members list when signed in as owner.

## Expected results

- Invite URL is generated in UI.
- Non-invited second user is blocked from joining until invite is consumed.
- Invite acceptance succeeds exactly once.
- Membership is visible in workspace member panel.

## UI quality checks

- Invite panel is easy to scan and operate.
- Invite URL display wraps cleanly and remains legible.
- Invite acceptance page presents a clear call-to-action.
