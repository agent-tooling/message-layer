# message-layer

A headless messaging layer for humans, agents, and apps.

## v1 implementation snapshot

This repository now includes a working v1 core with:

- orgs, actors, memberships, channels, threads
- structured append-only messages with ordered parts
- per-stream ordering via monotonic `streamSeq`
- idempotent append using `(orgId, streamId, actorId, idempotencyKey)`
- grant-based authorization
- permission request + approval/denial flow
- cursor updates and client registration
- event log + subscription replay from cursor
- append-only audit log with hash chaining

## Project layout

- `src/message_layer/store.py` SQLite schema and connection bootstrap.
- `src/message_layer/service.py` API implementation.
- `src/message_layer/models.py` core data classes.
- `tests/e2e/test_v1_flow.py` end-to-end tests (no mocks).

## Run tests

```bash
python -m pytest -q
```

## Minimum operations implemented

- `createOrg` -> `create_org`
- `createActor` -> `create_actor`
- `createChannel` -> `create_channel`
- `createThread` -> `create_thread`
- `appendMessage` -> `append_message`
- `listMessages` -> `list_messages`
- `subscribe` -> `subscribe`
- `updateCursor` -> `update_cursor`
- `createGrant` -> `create_grant`
- `revokeGrant` -> `revoke_grant`
- `createPermissionRequest` -> `create_permission_request`
- `resolvePermissionRequest` -> `resolve_permission_request`
- `registerClient` -> `register_client`
