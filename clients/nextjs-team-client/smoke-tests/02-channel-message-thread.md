# 02 Channel Message Thread

## Goal

Validate channel creation, channel switching, message send, and thread creation from message actions.

## Steps

1. Sign in as `owner+v1@example.com`.
2. Create channel named `frontend-v1`.
3. Switch between default channel and `frontend-v1`.
4. In `frontend-v1`, send message:
   - `Kickoff thread smoke test`
5. Confirm message appears in timeline.
6. Click `Create thread` on that message.
7. Confirm thread list/status updates (thread id visible in footer status line).

## Expected results

- Channel is created and appears immediately in sidebar list.
- Active-channel header updates when switching.
- Message appears with timestamp and sender id.
- Thread creation succeeds without error.

## UI quality checks

- Channel active state is visually obvious.
- Message cards have readable spacing.
- Thread action button placement feels discoverable and not noisy.
