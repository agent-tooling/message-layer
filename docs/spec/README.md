# message-layer API spec

This folder defines the **public API surface** of message-layer at a conceptual
level. It describes *what* the system exposes to clients, not *how* it is
implemented.

Scope:

- Resource model (orgs, actors, channels, threads, messages, streams, …)
- Authentication and authorization contract
- HTTP API shape (paths, verbs, inputs, outputs, errors)
- Event stream semantics
- Audit and ordering guarantees

Non-goals:

- Database schema, SQL, or storage engine details
- Transport-level framing beyond HTTP+JSON
- Client library ergonomics (terminal / Next.js clients have their own docs)

## Index

- [concepts.md](./concepts.md) — resources, identifiers, lifecycle
- [authentication.md](./authentication.md) — principals, scopes, providers
- [authorization.md](./authorization.md) — grants and permission requests
- [http-api.md](./http-api.md) — endpoint reference
- [events.md](./events.md) — event types and subscription semantics
- [errors.md](./errors.md) — error model and status codes

## Versioning

All HTTP endpoints are mounted under `/v1`. Breaking changes require a new
version prefix. Additive changes (new optional fields, new event types, new
endpoints) are permitted within `v1`.
