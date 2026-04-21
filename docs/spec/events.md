# Events

message-layer exposes domain changes as a stream of typed events. Events are
the primary mechanism for tailing a conversation, replaying state, and
driving external runtimes.

## Shape

```json
{
  "type": "message.appended",
  "payload": { ... },
  "streamSeq": 42,
  "createdAt": "2026-04-20T12:34:56.789Z"
}
```

| Field        | Type                          | Description                                                       |
|--------------|-------------------------------|-------------------------------------------------------------------|
| `type`       | `EventType`                   | See table below.                                                  |
| `payload`    | object                        | Event-specific payload.                                           |
| `streamSeq`  | number \| null                | Present when the event belongs to a specific stream.              |
| `createdAt`  | string (ISO-8601)             | Server-assigned timestamp.                                        |

## Event types

| Type                           | Scope      | Purpose                                                |
|--------------------------------|------------|--------------------------------------------------------|
| `org.created`                  | org        | An org was created.                                    |
| `channel.created`              | stream     | A channel (stream) was created.                        |
| `thread.created`               | stream     | A thread (stream) was created.                         |
| `message.appended`             | stream     | A new message landed on a stream.                      |
| `message.redacted`             | stream     | A message was redacted; content is no longer readable. |
| `membership.updated`           | org        | An actor's membership changed.                         |
| `cursor.updated`               | stream     | An actor's read cursor moved.                          |
| `grant.created`                | org        | A capability grant was issued.                         |
| `grant.revoked`                | org        | A grant was revoked.                                   |
| `permission_request.created`   | org        | An actor requested a capability.                       |
| `permission_request.resolved`  | org        | A permission request was approved or denied.           |
| `privacy_policy.updated`       | org        | The org's privacy policy changed.                      |
| `artifact.registered`          | stream     | An artifact was registered against a stream.           |
| `artifact.deleted`             | stream     | An artifact was soft-deleted.                          |
| `knowledge.promoted`           | org        | Content was promoted to org-level knowledge.           |
| `audit.logged`                 | org        | An audit entry was appended.                           |
| `client.registered`            | org        | A client endpoint was registered.                      |

Events whose scope is "stream" carry a non-null `streamSeq`. Org-scope events
carry `streamSeq: null`.

## Subscription semantics

Two transports expose the same event stream:

1. **HTTP replay** — `GET /v1/streams/:streamId/subscribe?fromSeq=N` returns
   events with `streamSeq > N` in `streamSeq` ascending order.
2. **WebSocket** — `GET /v1/ws` upgrades to a push channel that first
   replays events with `streamSeq > fromSeq` from the DB and then forwards
   live events from the in-process event bus as they are emitted.

Both transports check privacy: subscribing to a private stream that the
principal is not a member of yields a `403` (HTTP) or a `PERMISSION_DENIED`
error frame (WebSocket).

- Ordering: events returned within a single stream are strictly ordered by
  `streamSeq`. Clients that process events in returned order will observe
  causally consistent state.
- Replayability: events are durable. Calling subscribe with the same
  `fromSeq` always returns the same prefix of events, up to events created
  after the call.
- Gaps: `streamSeq` values are gap-free within a stream. If a client sees a
  gap, it MUST treat that as a bug and resynchronize.
- At-least-once vs exactly-once: replay is exactly-once from the server side
  (the same event has the same `streamSeq` forever). Clients that combine
  subscribe with push-based delivery MUST be prepared to deduplicate by
  `streamSeq`.

## Audit log

All event appends are mirrored into a per-org append-only audit log with
hash-chained entries. Authenticated principals holding the `audit:read`
scope can export the raw log via `GET /v1/audit/rows` and recompute the
chain via `GET /v1/audit/verify`; both endpoints are read-only and do not
permit mutation.
