# 01 Auth And Bootstrap

## Goal

Verify first-user signup, session bootstrap, default org/channel initialization, and initial UI layout quality.

## Steps

1. Open home page `http://127.0.0.1:3001`.
2. Create account:
   - email: `owner+v1@example.com`
   - password: `ownerpass123`
   - name: `Owner V1`
3. Confirm automatic transition into workspace UI.
4. Confirm:
   - left rail shows `Team Messaging`,
   - at least one channel is visible,
   - message composer is visible,
   - no red error text present.
5. Reload page and verify session persists.
6. Sign out and sign back in with same credentials.

## Expected results

- Signup and signin both succeed.
- Workspace loads without layout overlap or clipped content.
- Default channel is selected automatically.
- Session persists across reload.

## UI quality checks

- Header/title hierarchy is clear.
- Sidebar section headings are visually distinct.
- Buttons and inputs have enough spacing (no cramped controls).
