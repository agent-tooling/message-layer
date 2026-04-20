# Authentication

message-layer delegates **authentication** to its embedding host. The HTTP API
expects the caller to have already authenticated the request and to pass a
resolved **principal** on every call.

## Principal

A principal is the identity on whose behalf a request is made. It is a JSON
object with the following shape:

```json
{
  "actorId": "string",
  "orgId": "string",
  "scopes": ["string", ...],
  "provider": "string"
}
```

| Field      | Required | Description                                                                 |
|------------|----------|-----------------------------------------------------------------------------|
| `actorId`  | yes      | The actor this request acts as. Must belong to `orgId`.                    |
| `orgId`    | yes      | Tenant the actor belongs to.                                                |
| `scopes`   | yes      | Host-granted capability scopes that bypass per-resource grant checks.       |
| `provider` | yes      | Free-form identifier of the upstream auth provider (e.g. `better-auth`).   |

Principals are serialized as JSON and passed in the `x-principal` HTTP header.

### Header

```
x-principal: {"actorId":"…","orgId":"…","scopes":["grant:create"],"provider":"…"}
```

Every endpoint except `/health`, `POST /v1/orgs`, and `POST /v1/actors`
requires this header. Missing or malformed principals are rejected with
`401 Unauthorized`.

## Scopes

Scopes are **coarse-grained host capabilities** that are trusted implicitly
without a per-resource grant lookup. They are intended for privileged
controllers such as an admin console or an onboarding service, not for
end-user agents.

| Scope           | Effect                                                                 |
|-----------------|------------------------------------------------------------------------|
| `grant:create`  | May create and revoke grants and resolve permission requests.          |
| `channel:create`| May create channels without a per-org grant.                           |
| `thread:create` | May create threads without a per-channel grant.                        |
| `message:append`| May append messages to any stream in the principal's org.              |

Any capability string can be supplied in `scopes`; the API treats scopes as a
fast path that short-circuits grant lookups. See
[authorization.md](./authorization.md) for the grant-based path.

## Organization bootstrapping

Creating the first org and its first actors is intentionally unauthenticated
at the HTTP layer: hosts are expected to put those endpoints behind their own
admin gate.

- `POST /v1/orgs` — create an org
- `POST /v1/actors` — create an actor in an org

All other endpoints require a valid principal.
