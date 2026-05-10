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
| `provider` | yes      | Free-form identifier of the upstream auth provider or transport (e.g. `better-auth`, `bridge:telegram`). |

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

## Server-level API key gating

When the server is exposed over the public internet, the `api-key-header-auth`
built-in plugin adds a shared-secret gate in front of every `/v1/*` request —
including the normally-unauthenticated `POST /v1/orgs` and `POST /v1/actors`.

Enable it at startup:

```bash
MESSAGE_LAYER_API_KEY=your-secret PLUGINS=api-key-header-auth node dist/server.js
```

Or programmatically:

```typescript
await startServer({
  plugins: [
    { name: "api-key-header-auth", options: { strict: true } },
  ],
});
```

The plugin reads the expected key from an environment variable (default
`MESSAGE_LAYER_API_KEY`) and compares it to the value in the request header
(default `x-api-key`). Both the header name and env-var key are configurable.

With `strict: true` the server returns `503 Service Unavailable` on every
`/v1/*` request when the env variable is absent, preventing accidental
open-access deployments.

From the SDK, pass `apiKey` when constructing the client:

```typescript
const client = new MessageLayerClient({
  baseUrl: "https://ml.example.com",
  apiKey: process.env.MESSAGE_LAYER_API_KEY,
  principal: { ... },
});
```

The SDK sends the key on every HTTP request and includes it as a query
parameter on WebSocket upgrade URLs. See [plugins.md](./plugins.md) for the
full plugin option reference and [../sdk.md](../sdk.md) for the SDK option.
