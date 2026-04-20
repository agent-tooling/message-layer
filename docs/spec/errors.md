# Errors

All error responses are JSON with an `error` string field:

```json
{ "error": "missing message:append" }
```

## Status codes

| Status | Meaning                                                                                   |
|--------|-------------------------------------------------------------------------------------------|
| `200`  | Success.                                                                                  |
| `400`  | Validation error: malformed body, missing required field, invalid enum, etc.              |
| `401`  | Missing or invalid `x-principal` header.                                                  |
| `403`  | The principal is authenticated but lacks the required scope or grant.                     |
| `500`  | Unexpected server error.                                                                  |

## Common error conditions

| Condition                                                        | Status |
|------------------------------------------------------------------|--------|
| `x-principal` header missing or malformed                        | `401`  |
| Principal's actor is not in the given `orgId`                    | `403`  |
| Principal lacks a required capability (scope or grant)           | `403`  |
| Required body field missing or wrong type                        | `400`  |
| Unknown enum value (e.g. unsupported `streamType` or part type)  | `400`  |
| Resolving a permission request that is not in `open` state       | `400`  |
| `capability` query param missing on `GET /v1/grants/check`       | `400`  |

## Idempotency and errors

- A replayed message append with the same `idempotencyKey` returns `200`
  with `idempotent: true` — it is not an error.
- A message append that conflicts on `idempotencyKey` but with different
  content is not detected by the API; clients are responsible for stable
  keys per logical message.

## Forward compatibility

Clients SHOULD treat any `4xx`/`5xx` response with an unknown `error` string
as retryable only if the status code indicates so (`5xx`). The `error`
string is human-readable and not a stable machine-parseable code in `v1`.
