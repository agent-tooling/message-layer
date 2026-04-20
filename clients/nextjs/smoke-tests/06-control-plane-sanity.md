# 06 Control Plane Sanity

## Goal

Ensure critical browser-visible control-plane operations still behave after UI interactions.

## Steps

1. With owner session active, verify:
   - channels list loads,
   - members list loads,
   - messages list loads for active channel.
2. Refresh browser and ensure state repopulates from API.
3. Create one additional message in active channel.
4. Verify polling refresh updates timeline within 2 seconds.
5. Sign out and ensure protected team routes now return unauthorized if called directly.

## Expected results

- No empty-state regressions for core panels after reload.
- Polling mechanism stays stable (no duplicate spam or frozen list).
- Auth guard works after sign out.

## Regression checklist

- `GET /api/team/channels` succeeds while signed in.
- `GET /api/team/members` succeeds while signed in.
- `GET /api/team/channels/:id/messages` succeeds while signed in.
- protected endpoints fail after sign out.
