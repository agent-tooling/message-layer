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
| `constraints`  | object                  | Free-form JSON constraints (opaque to the API).          |
| `active`       | boolean                 | `false` after revocation.                                |

### Capability naming

Capabilities are dotted/colon-separated strings. Built-in capabilities used by
the API include:

| Capability        | Resource type | Description                                    |
|-------------------|---------------|------------------------------------------------|
| `channel:create`  | `org`         | Create a channel in the org.                   |
| `thread:create`   | `channel`     | Create a thread in the channel.                |
| `message:append`  | `channel` \| `thread` | Append a message to the stream.        |

Consumers (e.g. the agent kernel) may define and check their own capability
names, such as `tool:execute:<toolName>`.

### Endpoints

- `POST /v1/grants` — create a grant (requires `grant:create` scope).
- `POST /v1/grants/:grantId/revoke` — revoke a grant.
- `GET /v1/grants/check?actorId=…&capability=…` — check whether an actor
  currently holds the capability (ignoring resource scoping).

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
| `createdAt`     | string         | ISO-8601.                                 |
| `resolvedAt`    | string \| null | Set on approve/deny.                      |
| `grantId`       | string \| null | Grant issued on approval, if any.         |

### Endpoints

- `POST /v1/permission-requests` — open a request.
- `GET /v1/permission-requests?actorId=…` — list open requests, optionally
  filtered by actor.
- `POST /v1/permission-requests/:requestId/resolve` — approve or deny
  (requires `grant:create` scope). Approval automatically issues a matching
  grant.

## Resolution semantics

- A request may only be resolved once. Subsequent resolutions return an
  error.
- Approving a request creates a new grant with
  `capability = action`, `resourceType`, `resourceId`, and default
  constraints. The response links the resulting `grantId` to the request.
- Denying a request leaves no grant behind; the requester must open a new
  request to try again.
