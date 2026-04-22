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

### `GET /v1/actors/:actorId/grants`

List all active grants held by a specific actor. Requires read access to the
actor's org (any authenticated principal in the same org may call this).

**Response** `200`
```json
{
  "grants": [{
    "grantId": "...", "actorId": "...", "capability": "message:append",
    "resourceType": "channel", "resourceId": "...",
    "expiresAt": null, "maxUses": null, "usesCount": 0, "remainingUses": null,
    "constraints": {}, "createdAt": "...", "createdByActorId": "...", "active": true
  }]
}
```

### `POST /v1/actors/:actorId/revoke-grants`

Revoke every active grant held by an actor in one call ("kick"). Requires
`grant:create` scope. Emits one `grant.revoked` event per affected grant,
each carrying `bulk: true`.

**Request** (optional body)
| Field  | Type   | Required | Description |
|--------|--------|----------|-------------|
| reason | string | no       | Free-form reason recorded in each `grant.revoked` event. |

**Response** `200` — `{ "revokedGrantIds": ["..."] }`

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
{ "type": "text" | "mention" | "command" | "tool_call" | "tool_result" | "artifact" | "approval_request" | "approval_response" | "ui",
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
- `GET /v1/permission-requests/:requestId` → `{ request: { status, action, resourceType, resourceId, context, createdAt, resolvedAt, grantId, ... } }`
- `POST /v1/permission-requests/:requestId/resolve` — `{ approve, notes? }` → `{ ok: true }`

## Command Registry

Apps and agents register named slash commands. Each registration is gated by an admin approval
(`command:register` permission request). Once approved the command is active and invocations
resolve to the owning actor.

**Namespacing**

- Short form: `command: "deploy"` — resolved to the single active registration for that name in the
  current channel/org scope. If two owners hold the same short name the invocation is rejected with
  `VALIDATION`; callers must use the long form.
- Long form: `command: "deploybot:deploy"` — always unambiguous; owner is looked up by
  `display_name` in the same org.
- Unregistered commands pass through with `commandId: null` (backward compatible).

### `POST /v1/commands`

Register a slash command. Creates a `pending` registration and opens a `command:register`
permission request.

**Request**
| Field       | Type   | Required | Description |
|-------------|--------|----------|-------------|
| name        | string | yes      | Command name. Letters, digits, hyphens, and underscores only. |
| description | string | no       | Human-readable description shown in the approval inbox. |
| argsSchema  | object | no       | JSON schema hint for the expected `args` payload. |
| channelId   | string | no       | When set, scopes the registration to a single channel. |

**Response** `201` — `{ "commandId": "string", "requestId": "string" }`

After receiving this response, the owning actor should poll `GET /v1/permission-requests?actorId=…`
or subscribe to `command.registered` events to know when the admin approves.

### `GET /v1/commands`

List active commands visible to the caller's org.

**Query parameters**
| Parameter | Type   | Description |
|-----------|--------|-------------|
| channelId | string | When provided, includes channel-scoped commands for this channel alongside org-scoped ones. |

**Response** `200`
```json
{
  "commands": [
    {
      "id": "string",
      "orgId": "string",
      "channelId": "string | null",
      "name": "string",
      "ownerActorId": "string",
      "description": "string | null",
      "argsSchema": {},
      "status": "active",
      "permissionRequestId": "string | null",
      "createdAt": "ISO-8601"
    }
  ]
}
```

### `DELETE /v1/commands/:commandId`

Disable a command. The command's status is set to `disabled` and it no longer appears in `GET
/v1/commands`. Only the command owner or an admin (`grant:create` capability) may delete.

**Response** `200` — `{ "ok": true }`

## Artifacts

Artifacts are binary payloads scoped to a stream (channel or thread). Core
stores only metadata in SQL; the bytes go through a pluggable blob
`StorageAdapter` (default: local filesystem under `./.data/artifacts`). See
[concepts.md](./concepts.md) for privacy rules.

### `POST /v1/artifacts`

Register a new artifact. Requires `artifact:register` **or** `message:append`
on the target stream, plus read access to that stream (channel membership for
private channels).

**Request**
| Field          | Type                      | Required | Description |
|----------------|---------------------------|----------|-------------|
| streamId       | string                    | yes      | Channel or thread id. |
| streamType     | `"channel"` \| `"thread"` | yes      | Discriminates the stream kind. |
| filename       | string                    | yes      | Original filename; surfaced in `Content-Disposition` on download. |
| contentType    | string                    | yes      | MIME type. |
| contentBase64  | string                    | yes      | Raw bytes, base64-encoded. Must decode to `> 0` bytes and `≤ artifacts.maxBytes` (default 10 MB). |
| sha256         | string                    | no       | Optional hex digest. Validated against server-computed digest. |

**Response** `200`
```json
{ "artifact": {
  "id": "...", "orgId": "...", "streamId": "...", "streamType": "channel",
  "filename": "hi.txt", "contentType": "text/plain", "size": 15,
  "sha256": "...", "storageKind": "local-fs",
  "createdByActorId": "...", "createdAt": "...",
  "deleted": false, "deletedAt": null, "deletedByActorId": null
}}
```

### `GET /v1/artifacts/:artifactId`

Artifact metadata. Requires read access to the owning stream.

**Response** `200` — same `{ "artifact": ArtifactRecord }` shape as above.

### `GET /v1/artifacts/:artifactId/content`

Binary download. Requires read access to the owning stream. Deleted
artifacts return `404`.

**Response** `200`
- body: raw bytes
- `Content-Type`: the artifact's stored MIME type
- `Content-Length`: stored byte size
- `Content-Disposition`: `attachment; filename="<filename>"` (sanitized)
- `x-artifact-id`, `x-artifact-sha256`: convenience headers for clients that
  want to verify the download.

### `GET /v1/streams/:streamId/artifacts`

List artifacts belonging to a stream, oldest first. Hides soft-deleted
artifacts by default.

**Query**
| Param           | Type    | Default | Description |
|-----------------|---------|---------|-------------|
| includeDeleted  | boolean | `false` | When `true`, returns tombstones too (`deleted: true`). |

**Response** `200` — `{ "artifacts": ArtifactRecord[] }`

### `DELETE /v1/artifacts/:artifactId`

Soft-delete an artifact. Allowed for the original uploader, for principals
with the `artifact:admin` scope, or for principals holding an
`artifact:admin` grant on the owning stream. Emits `artifact.deleted`.

**Query**
| Param   | Type   | Default | Description |
|---------|--------|---------|-------------|
| reason  | string | `""`    | Free-form reason attached to the `artifact.deleted` event. |

**Response** `200` — `{ "ok": true }`

Artifacts referenced from message parts (`{ "type": "artifact", "payload": { "artifactId": "..." } }`)
are the recommended way to attach files to conversations; messages stay
small and bytes stay behind the permissioned `GET /v1/artifacts/:id/content`
endpoint.

## Memory (provided by the `memory` plugin)

The `memory` plugin ships in `src/plugins/memory.ts` and enables five
routes when added to `config.plugins`. **Memory units** are deduplicated,
keyword-tagged projections of text parts from `message.appended` events
— not verbatim copies. Identical text in the same stream collapses to a
single unit with multiple provenance edges.

The source `streamId`, `streamType`, and `visibility` are snapshotted at
insertion time. Reads delegate to the core `assertCanReadStream`; promotion
goes through `MessageLayer.recordMemoryPromotion`, which emits
`memory.promoted` and writes it to the per-org hash-chained audit log.

### `GET /v1/memory?streamId=...`

List memory units bound to a stream. Requires read access to the source
stream (privacy delegated to the core service).

**Query**
| Param     | Type    | Default | Description |
|-----------|---------|---------|-------------|
| streamId  | string  | —       | Required unless `promoted=true`. |
| promoted  | boolean | `false` | When `true` (with no `streamId`) returns all org-wide promoted units; when `true` *and* `streamId` is given, restricts to promoted units inside that stream. |

**Response** `200` — `{ "units": MemoryUnit[] }`

### `GET /v1/memory/search?q=...`

Lexical search across every memory unit the principal can read (their
visible streams + org-wide promoted units). Returns ranked hits with
short snippet highlights.

**Query**
| Param     | Type    | Default | Description |
|-----------|---------|---------|-------------|
| q         | string  | —       | Required search query. |
| streamId  | string  | —       | When provided, restricts search to that stream (still privacy-checked). |
| limit     | number  | `20`    | Max hits, capped at 100. |

**Response** `200` — `{ "query": "...", "hits": MemoryHit[] }`

### `GET /v1/memory/:memoryId`

Fetch a single memory unit. Non-promoted units require read access to the
source stream; promoted units are readable by any org member.

### `POST /v1/memory/:memoryId/promote`

Promote a unit org-wide. Requires `memory:promote` (scope or grant on
the org). Calls `MessageLayer.recordMemoryPromotion`, which emits
`memory.promoted` on the shared bus and into the audit log; the plugin
listens and flips its local `promoted` bit in response.

**Request**
| Field    | Type   | Required | Description |
|----------|--------|----------|-------------|
| summary  | string | no       | Free-form annotation recorded with the promotion event. |

**Response** `200` — `{ "unit": MemoryUnit }`

`MemoryUnit` shape:
```json
{
  "id": "...", "orgId": "...",
  "sourceStreamId": "...", "sourceStreamType": "channel",
  "sourceVisibility": "private|public",
  "canonicalText": "...", "summary": "...", "keywords": ["..."],
  "createdByActorId": "...",
  "sourceMessageIds": ["...", "..."],
  "promoted": true, "promotedAt": "...", "promotedByActorId": "...",
  "promotionSummary": "...",
  "createdAt": "...", "updatedAt": "..."
}
```

`MemoryHit` shape:
```json
{ "unit": MemoryUnit, "score": 8.2, "highlights": ["…snippet…"] }
```

## Search (provided by the `search` plugin)

The `search` plugin ships in `src/plugins/search.ts` and enables two
routes when added to `config.plugins`. It maintains a derived index of
the entities the message-layer manages — actors (`human`, `agent`, `app`),
channels, threads, messages, and (when the `memory` plugin is enabled)
memory units — and serves privacy-filtered lexical queries across all of
them in a single request.

Every result is filtered through the same core checks the rest of the
system uses (`assertCanReadStream` for stream-scoped entities, org
membership for actors, the promotion bit for memory).

### `GET /v1/search?q=...`

Mixed-entity ranked search.

**Query**
| Param         | Type     | Default | Description |
|---------------|----------|---------|-------------|
| q             | string   | —       | Required search query. |
| entityTypes   | csv      | —       | Comma-separated subset of `actor,channel,thread,message,memory`. |
| streamId      | string   | —       | Restrict stream-scoped hits to one stream. |
| actorType     | enum     | —       | `human` \| `agent` \| `app`. Restricts `actor` hits. |
| limit         | number   | `20`    | Max hits, capped at 100. |

**Response** `200` — `{ "query": "...", "hits": SearchHit[] }`

### `GET /v1/search/suggest?q=...`

Lightweight autosuggest for actors, channels, and threads. Designed for
command-bar UX. Capped at 20 suggestions.

**Response** `200` — `{ "query": "...", "suggestions": SearchSuggestion[] }`

`SearchHit` shape:
```json
{
  "documentId": "...", "entityType": "actor|channel|thread|message|memory",
  "entityId": "...", "score": 7.4, "title": "...", "snippet": "...",
  "highlights": ["..."],
  "sourceStreamId": "..."|null, "sourceStreamType": "channel|thread"|null,
  "sourceVisibility": "private|public"|null,
  "promoted": false, "actorType": "human|agent|app"|null,
  "metadata": { ... }, "updatedAt": "..."
}
```

`SearchSuggestion` shape:
```json
{ "entityType": "actor", "entityId": "...", "label": "...", "actorType": "human" }
```

## Durable Streams (provided by the `durable-streams` plugin)

The `durable-streams` plugin adds an append/read/commit primitive for
progressive agent output. This is useful when agents emit token deltas or
long-running progress updates and callers need resumable reads before the
final message is committed into a channel/thread.

### `POST /v1/durable-streams`

Create a durable stream owned by the principal.

**Request**
| Field            | Type                      | Required | Description |
|------------------|---------------------------|----------|-------------|
| targetStreamId   | string                    | no       | Channel/thread id to commit into later. |
| targetStreamType | `"channel"` \| `"thread"` | no       | Must be provided with `targetStreamId`. |
| contentType      | string                    | no       | Defaults to `text/plain; charset=utf-8`. |
| metadata         | object                    | no       | Opaque context for callers. |

**Response** `200` — `{ "durableStreamId": "...", "status": "open", "offset": 0 }`

### `POST /v1/durable-streams/:streamId/chunks`

Append one or more text chunks in-order.

**Request**
| Field  | Type                      | Required | Description |
|--------|---------------------------|----------|-------------|
| chunks | `Array<{ text: string }>` | yes      | Appended atomically in order. |

**Response** `200` — `{ "durableStreamId": "...", "appended": 2, "offset": 2 }`

### `GET /v1/durable-streams/:streamId/read`

Read chunks after an offset. Supports catch-up and long-poll style live mode.

**Query**
| Param     | Type    | Default | Description |
|-----------|---------|---------|-------------|
| offset    | number  | `0`     | Return chunks with `chunk_offset > offset`. |
| limit     | number  | `200`   | Max chunks per response (bounded server-side). |
| live      | boolean | `false` | When `true`, waits for new chunks while stream is open. |
| timeoutMs | number  | plugin default | Max long-poll wait when `live=true`. |

**Response** `200`
```json
{
  "durableStreamId": "...",
  "status": "open",
  "fromOffset": 0,
  "nextOffset": 2,
  "upToDate": true,
  "chunks": [
    { "offset": 1, "text": "Hello ", "createdAt": "..." },
    { "offset": 2, "text": "world", "createdAt": "..." }
  ]
}
```

### `GET /v1/durable-streams/:streamId/tail`

SSE tail (`text/event-stream`) for live chunk delivery.

Events:
- `ready` — initial cursor info
- `chunks` — new chunk batch
- `eof` — stream closed/committed
- `error` — stream-level error

### `POST /v1/durable-streams/:streamId/close`

Close the stream and persist a backup payload to the configured artifact
storage adapter.

**Response** `200` — `{ "durableStreamId": "...", "status": "closed", "backupKey": "...", "offset": N }`

### `POST /v1/durable-streams/:streamId/commit`

Concatenate all chunks and append a final text message to the configured
target stream (`targetStreamId` / `targetStreamType`), then mark stream as
`committed`.

**Request**
| Field          | Type   | Required | Description |
|----------------|--------|----------|-------------|
| idempotencyKey | string | no       | Optional override for commit idempotency key. |

**Response** `200`
```json
{
  "durableStreamId": "...",
  "status": "committed",
  "committedMessageId": "...",
  "backupKey": "...",
  "streamSeq": 42
}
```

## Webhooks (provided by the `webhooks` plugin)

The `webhooks` plugin delivers domain events as outbound HTTP POST requests to
registered subscriber URLs. All routes require the `webhooks` plugin to be
enabled (see [plugins.md](./plugins.md)).

### `POST /v1/webhooks/subscriptions`

Register a webhook subscription. Requires `webhook:subscribe` on the principal.

**Request**
| Field       | Type       | Required | Description |
|-------------|------------|----------|-------------|
| endpoint    | string     | yes      | URL to POST events to. |
| eventTypes  | string[]   | yes      | Event types to subscribe to (e.g. `["message.appended"]`). |
| streamId    | string     | no       | Restrict delivery to events on this stream. |

**Response** `200` — `{ "subscriptionId": "...", "ok": true }`

### `GET /v1/webhooks/subscriptions`

List the principal's webhook subscriptions. Requires `webhook:read`.

**Query**
| Param            | Type    | Default | Description |
|------------------|---------|---------|-------------|
| includeDisabled  | boolean | `false` | Include disabled subscriptions. |

**Response** `200` — `{ "subscriptions": [{ "id", "endpoint", "eventTypes", "streamId", "enabled", "createdAt" }] }`

### `PATCH /v1/webhooks/subscriptions/:subscriptionId`

Enable or disable a subscription.

**Request**
| Field    | Type    | Required | Description |
|----------|---------|----------|-------------|
| enabled  | boolean | yes      | `true` to enable, `false` to disable. |

**Response** `200` — `{ "ok": true }`

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
