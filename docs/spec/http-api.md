# HTTP API

All endpoints are JSON over HTTP. Request and response bodies are
`application/json`. Every request except `/health`, `POST /v1/orgs`, and
`POST /v1/actors` requires an `x-principal` header (see
[authentication.md](./authentication.md)).

This reference lists each endpoint's purpose, inputs, and outputs.
Field-level validation and error behaviour are summarized in
[errors.md](./errors.md).

## Health

### `GET /health`

Liveness probe.

**Response** `200` — `{ "ok": true }`

## Organizations

### `POST /v1/orgs`

Create a new organization.

**Request**
| Field | Type   | Required | Description |
|-------|--------|----------|-------------|
| name  | string | yes      | Human-readable org name. |

**Response** `200` — `{ "orgId": "string" }`

## Actors

### `POST /v1/actors`

Create an actor inside an org.

**Request**
| Field        | Type                            | Required | Description |
|--------------|---------------------------------|----------|-------------|
| orgId        | string                          | yes      | Owning org. |
| actorType    | `"human"` \| `"agent"` \| `"app"` | yes    | Actor kind. |
| displayName  | string                          | yes      | Human-readable label. |

**Response** `200` — `{ "actorId": "string" }`

### `GET /v1/actors`

List actors in the principal's org.

**Response** `200` — `{ "actors": [{ "actorId", "actorType", "displayName", "createdAt" }] }`

### `GET /v1/members`

List org memberships (actors with an org-wide membership, not limited to a
channel).

**Response** `200` — `{ "members": [{ "actorId", "actorType", "displayName", "role", "createdAt" }] }`

## Channel membership

### `POST /v1/channels/:channelId/members`

Add an actor as a member of a channel. Required to read or post in a
private channel. Must be invoked by the channel creator, by a principal with
the `channel:admin` scope, or by a principal holding a `channel:admin` grant
on the channel.

**Request**
| Field    | Type   | Required | Description |
|----------|--------|----------|-------------|
| actorId  | string | yes      | Actor to add. Must belong to the principal's org. |
| role     | string | no       | Defaults to `"member"`. |

**Response** `200` — `{ "ok": true }`

### `DELETE /v1/channels/:channelId/members/:actorId`

Remove a member. An actor may self-remove without admin rights.

**Response** `200` — `{ "ok": true }`

### `GET /v1/channels/:channelId/members`

List members of a channel. Requires read access to the channel (public, or
existing membership).

**Response** `200` — `{ "members": [{ "actorId", "role", "createdAt" }] }`

## Channels

### `POST /v1/channels`

Create a channel in the principal's org. Requires `channel:create`.

**Request**
| Field       | Type                         | Required | Description |
|-------------|------------------------------|----------|-------------|
| name        | string                       | yes      | Channel name. |
| visibility  | `"private"` \| `"public"`    | no       | Defaults to `"private"`. |

**Response** `200` — `{ "channelId": "string" }`

### `GET /v1/channels`

List channels the principal is a member of.

**Response** `200` — `{ "channels": [{ "id", "name", "visibility", "createdByActorId", "createdAt" }] }`

## Threads

### `POST /v1/threads`

Create a thread anchored to a message in a channel. Requires
`thread:create` on the channel.

**Request**
| Field            | Type                      | Required | Description |
|------------------|---------------------------|----------|-------------|
| channelId        | string                    | yes      | Parent channel. |
| parentMessageId  | string                    | yes      | Message in `channelId` the thread hangs off. |
| visibility       | `"private"` \| `"public"` | no       | Defaults to `"private"`. |

**Response** `200` — `{ "threadId": "string" }`

### `GET /v1/channels/:channelId/threads`

List threads in a channel.

**Response** `200` — `{ "threads": [{ "id", "parentMessageId", "visibility", "createdByActorId", "createdAt" }] }`

## Messages

### `POST /v1/messages`

Append a message to a stream. Requires `message:append` on the target stream.
Idempotent on `(orgId, streamId, actorId, idempotencyKey)`.

**Request**
| Field              | Type                       | Required | Description |
|--------------------|----------------------------|----------|-------------|
| streamId           | string                     | yes      | Channel or thread id. |
| streamType         | `"channel"` \| `"thread"`  | yes      | Discriminates the stream kind. |
| parts              | `MessagePart[]`            | yes      | Ordered parts; see [concepts.md](./concepts.md). |
| idempotencyKey     | string                     | yes      | Client-chosen dedupe key. |
| autoRequestOnDeny  | boolean                    | no       | If `true`, a missing grant opens a permission request instead of returning `403`. |

`MessagePart`:
```json
{ "type": "text" | "tool_call" | "tool_result" | "artifact" | "approval_request" | "approval_response",
  "payload": { ... } }
```

**Response** `200` on success
```json
{ "messageId": "string", "streamSeq": 42, "idempotent": false }
```

**Response** `200` when denied with `autoRequestOnDeny: true`
```json
{ "denied": true, "requestId": "…", "capability": "message:append",
  "resourceType": "channel", "resourceId": "…" }
```

`idempotent` is `true` when the request replayed a prior append; in that
case `messageId` and `streamSeq` refer to the original message.

### `POST /v1/messages/:messageId/redact`

Redact a message. The message's slot in the stream is preserved (its
`streamSeq` is kept), but all parts are removed and the record is marked
`redacted`. Authorized if the caller is the original author, holds the
`message:redact` scope, or has a `message:redact` grant on the stream.

**Request**
| Field  | Type   | Required | Description |
|--------|--------|----------|-------------|
| reason | string | no       | Free-form reason attached to the `message.redacted` event. |

**Response** `200` — `{ "ok": true }`

### `GET /v1/streams/:streamId/messages`

List messages in a stream, ordered by `streamSeq` ascending.

**Query**
| Param     | Type   | Default | Description |
|-----------|--------|---------|-------------|
| afterSeq  | number | `0`     | Return messages with `streamSeq > afterSeq`. |
| limit     | number | `50`    | Max messages to return. |

**Response** `200` — `{ "messages": MessageRecord[] }`

Each `MessageRecord` has:
```json
{ "id": "...", "streamSeq": 1, "actorId": "...", "createdAt": "...",
  "parts": [{ "index": 0, "type": "...", "payload": {...} }] }
```

## Events / subscribe

### `GET /v1/streams/:streamId/subscribe`

Replay events for a stream from a cursor. This is the canonical "tail" API.
See [events.md](./events.md) for event types and ordering.

**Query**
| Param   | Type   | Default | Description |
|---------|--------|---------|-------------|
| fromSeq | number | `0`     | Return events whose `streamSeq` is `> fromSeq`. Events without a `streamSeq` are replayed once when `fromSeq == 0`. |

**Response** `200`
```json
{ "events": [
  { "type": "message.appended", "payload": {...}, "streamSeq": 1, "createdAt": "..." }
]}
```

## Cursors

### `POST /v1/cursors`

Update the principal's read cursor on a stream.

**Request**
| Field         | Type   | Required | Description |
|---------------|--------|----------|-------------|
| streamId      | string | yes      |             |
| lastSeenSeq   | number | yes      | Highest `streamSeq` delivered to the client. |
| lastAckSeq    | number | yes      | Highest `streamSeq` the client has processed. |

**Response** `200` — `{ "ok": true }`

### `GET /v1/streams/:streamId/cursor`

Read the principal's cursor on a stream.

**Response** `200` — `{ "cursor": { "lastSeenSeq", "lastAckSeq", "updatedAt" } | null }`

## Grants and permission requests

See [authorization.md](./authorization.md) for semantics.

- `POST /v1/grants` — `{ actorId, resourceType, resourceId, capability, expiresAt?, constraints? }` → `{ grantId }`
- `POST /v1/grants/:grantId/revoke` → `{ ok: true }`
- `GET /v1/grants/check?actorId&capability` → `{ hasGrant: boolean }`
- `POST /v1/permission-requests` — `{ action, resourceType, resourceId }` → `{ requestId }`
- `GET /v1/permission-requests?actorId` → `{ requests: [...] }`
- `POST /v1/permission-requests/:requestId/resolve` — `{ approve, notes? }` → `{ ok: true }`

## Clients

### `POST /v1/clients`

Register a client endpoint owned by the principal's actor. Used by external
runtimes to advertise where they can receive deliveries or callbacks.

**Request**
| Field     | Type   | Required | Description |
|-----------|--------|----------|-------------|
| endpoint  | string | yes      | Opaque endpoint (e.g. URL or handle). |
| metadata  | object | no       | Free-form JSON metadata. |

**Response** `200` — `{ "clientId": "string" }`

## Audit

### `GET /v1/audit/rows`

Export the per-org audit log. Requires the `audit:read` scope on the
principal. Returns every audit entry, including prev/current hash for
verification.

**Response** `200` — `{ "rows": [{ "id", "eventType", "payload", "prevHash", "eventHash", "createdAt" }] }`

### `GET /v1/audit/verify`

Recompute the hash chain and report the first inconsistent index, if any.
Requires `audit:read`.

**Response** `200` — `{ "valid": boolean, "firstBadIndex": number | null, "total": number }`

## WebSocket

### `GET /v1/ws` (upgrade)

A WebSocket endpoint that speaks a small JSON protocol for realtime stream
subscriptions. The `x-principal` header (or `?principal=<json>` query
parameter) is required on upgrade. See the root `README.md` for the message
shapes.
