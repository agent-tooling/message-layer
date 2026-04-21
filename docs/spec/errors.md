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
| `401`  | Missing or invalid `x-principal` header (or missing/incorrect API key when `api-key-header-auth` is active). |
| `403`  | The principal is authenticated but lacks the required scope or grant, or attempted to access a private stream it is not a member of. |
| `404`  | Referenced resource (channel, thread, message, grant, permission request) does not exist in the principal's org. |
| `500`  | Unexpected server error.                                                                  |
| `503`  | Server is misconfigured: `api-key-header-auth` is running in `strict` mode and `MESSAGE_LAYER_API_KEY` is not set. |

Error payloads also carry a machine-friendly `code` field:

| `code`              | Meaning |
|---------------------|---------|
| `VALIDATION`        | Body or query did not pass validation. |
| `PERMISSION_DENIED` | Scope/grant/membership check failed. |
| `NOT_FOUND`         | Referenced id does not exist. |
| `ERROR`             | Generic bucket for unclassified errors. |

`PermissionError` responses also include `capability`, `resourceType`, and
`resourceId` fields when available, so callers can mint a matching
permission request without parsing the human-readable message.

## Common error conditions

| Condition                                                        | Status |
|------------------------------------------------------------------|--------|
| `x-principal` header missing or malformed                        | `401`  |
| API key header missing or incorrect (`api-key-header-auth` active) | `401` |
| Principal's actor is not in the given `orgId`                    | `403`  |
| Principal lacks a required capability (scope or grant)           | `403`  |
| Required body field missing or wrong type                        | `400`  |
| Unknown enum value (e.g. unsupported `streamType` or part type)  | `400`  |
| Resolving a permission request that is not in `open` state       | `400`  |
| `capability` query param missing on `GET /v1/grants/check`       | `400`  |
| `api-key-header-auth` in strict mode with env var unset          | `503`  |

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
