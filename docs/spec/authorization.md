# Authorization

Authorization in message-layer is **capability-based**. A principal may
perform an action if either:

1. it carries a matching host **scope** on its principal (see
   [authentication.md](./authentication.md)), or
2. it holds an active **grant** on the target resource.

If neither applies, the caller may file a **permission request** for a human
or privileged actor to resolve.

## Grants

A grant gives an actor a named capability on a specific resource (or on a
resource type in general).

### Shape

| Field          | Type                    | Description                                              |
|----------------|-------------------------|----------------------------------------------------------|
| `grantId`      | string                  | Opaque id.                                               |
| `orgId`        | string                  | Owning org.                                              |
| `actorId`      | string                  | Grantee.                                                 |
| `capability`   | string                  | Capability name (e.g. `message:append`).                 |
| `resourceType` | string                  | Resource kind (e.g. `channel`, `thread`, `org`).         |
| `resourceId`   | string \| null          | Specific resource, or `null` for "any of this type".     |
| `expiresAt`    | string \| null          | ISO-8601 expiry, or `null` for no expiry.                |
| `maxUses`      | number \| null          | Hard cap on consumptions; grant auto-revokes when reached. `1` is the "approve once" case. |
| `usesCount`    | number                  | Monotonically incremented; starts at `0`.                |
| `constraints`  | object                  | Free-form JSON constraints (opaque to the API; used by plugins for per-argument scoping, e.g. `{ channel: { eq: "poems" } }`). |
| `active`       | boolean                 | `false` after revocation.                                |

### Grant consumption

Every capability-backed mutation (append a message, create a channel, upload
an artifact, redact someone else's message) consumes **exactly one use** of
a matching grant inside the same SQL transaction as the action's own write.
The consume is an atomic
`UPDATE grants SET uses_count = uses_count + 1 WHERE … RETURNING id`, so
two concurrent consumers of a `maxUses: 1` grant can never both succeed —
the second sees a filtered-out row and the action rolls back with
`PERMISSION_DENIED`.

Scopes (principal-carried capabilities) bypass the counter entirely. They
model admin sessions and service accounts, which aren't rate-limited.

When a grant reaches its `maxUses`, core immediately emits a
`grant.revoked` event with `autoRevoked: true` so plugins (notifications,
audit UIs) can show the exhaustion alongside the triggering action.

### Capability naming

Capabilities are dotted/colon-separated strings. Built-in capabilities used by
the API include:

| Capability        | Resource type | Description                                    |
|-------------------|---------------|------------------------------------------------|
| `channel:create`  | `org`         | Create a channel in the org.                   |
| `thread:create`   | `channel`     | Create a thread in the channel.                |
| `message:append`  | `channel` \| `thread` | Append a message to the stream.        |
| `command:invoke`  | `channel` \| `thread` | Append and invoke a structured `command` part. |

Consumers (e.g. the agent kernel) may define and check their own capability
names, such as `tool:execute:<toolName>`.

### Endpoints

- `POST /v1/grants` — create a grant (requires `grant:create` scope). Body
  accepts `{ actorId, resourceType, resourceId?, capability, expiresAt?, constraints?, maxUses? }`.
- `POST /v1/grants/:grantId/revoke` — revoke a grant; optional
  `{ reason }` body is recorded on the grant and in the emitted event.
- `POST /v1/actors/:actorId/revoke-grants` — "kick" an actor by revoking
  every live grant it holds in one call. Emits one `grant.revoked` event
  per affected grant, each carrying `bulk: true` so listeners can
  distinguish operator-driven mass revocation from single-grant cleanup.
- `GET /v1/grants/check?actorId=…&capability=…` — check whether an actor
  currently holds the capability (ignoring resource scoping). Returns
  `false` once a `maxUses` cap has been reached.

## Permission requests

When an actor attempts an action it does not have a grant for, a higher-level
flow (typically the agent runtime) can open a **permission request** instead
of failing hard. A human or privileged actor then resolves the request.

### Shape

| Field           | Type           | Description                               |
|-----------------|----------------|-------------------------------------------|
| `requestId`     | string         | Opaque id.                                |
| `actorId`       | string         | Actor that needs the capability.          |
| `action`        | string         | Capability being requested.               |
| `resourceType`  | string         | Target resource kind.                     |
| `resourceId`    | string \| null | Target resource, or `null`.               |
| `status`        | `open` \| `approved` \| `denied` | Lifecycle state.       |
| `context`       | object         | Capability-specific structured payload describing *what* the actor tried to do. `message:append` auto-populates it with the stream id, a preview of each `text` part (truncated to 500 chars), and the type + top-level keys of non-text parts. `command:invoke` auto-populates a command summary (`kind: "command.invoke"`) when command parts are denied with `autoRequestOnDeny`. Callers opening a request explicitly (e.g. agents) should populate it with enough args for a human to decide. See [§ Purpose-aware permissions](#purpose-aware-permissions). |
| `createdAt`     | string         | ISO-8601.                                 |
| `resolvedAt`    | string \| null | Set on approve/deny.                      |
| `grantId`       | string \| null | Grant issued on approval, if any.         |

### Purpose-aware permissions

AGENTS.md rule #5 requires permissions to be **purpose-aware**: the human
resolving a request should see *what* the agent wants to do, not just
"`message:append` on `channel:<id>`". Core implements this by persisting a
JSON `context` blob alongside every permission request and surfacing it
through the listing endpoint and the `permission_request.created` event.

Example for `POST /v1/messages` with `autoRequestOnDeny: true`:

```json
{
  "kind": "message.append",
  "streamType": "channel",
  "streamId": "bd0efd…",
  "idempotencyKey": "bot-3",
  "partCount": 1,
  "parts": [
    { "index": 0, "type": "text", "text": "time to ship, friends" }
  ]
}
```

External callers (e.g. agents opening a `channel:create` request via
`POST /v1/permission-requests`) pass the context themselves. Anything
sensitive should be omitted or redacted by the caller — core treats the
blob as opaque structured data.

### Endpoints

- `POST /v1/permission-requests` — open a request. Body:
  `{ action, resourceType, resourceId?, context? }`.
- `GET /v1/permission-requests?actorId=…` — list open requests, optionally
  filtered by actor. Each row includes the stored `context`.
- `POST /v1/permission-requests/:requestId/resolve` — approve or deny
  (requires `grant:create` scope). Body:
  `{ approve, notes?, expiresAt?, maxUses? }`. Approval auto-issues a
  matching grant with the supplied restrictions (see below).

## Resolution semantics

- A request may only be resolved once. Subsequent resolutions return an
  error.
- Approving a request creates a new grant with
  `capability = action`, `resourceType`, `resourceId`, the supplied
  `expiresAt` (if any), and the supplied `maxUses` (if any). Default
  constraints are empty. The response links the resulting `grantId` to
  the request, and the `permission_request.resolved` event carries both
  `expiresAt` and `maxUses` so plugins can react.
- Denying a request leaves no grant behind; the requester must open a new
  request to try again.

### Approval modes

The combination of `expiresAt` and `maxUses` expresses every common
approval UX pattern:

| Intent                    | `expiresAt`  | `maxUses` |
|---------------------------|--------------|-----------|
| Approve once              | `null`       | `1`       |
| Approve for N minutes     | `<iso>`      | `null`    |
| Approve for N minutes, N uses | `<iso>`  | `N`       |
| Approve forever           | `null`       | `null`    |

A fully consumed `maxUses` grant auto-deactivates (see
[Grant consumption](#grant-consumption)) and emits a `grant.revoked`
event with `autoRevoked: true`. An expired grant is filtered out of
`hasGrant` / `consumeGrant` reads without any state change — the column
stays as-is so audit trails keep showing the original expiry.
