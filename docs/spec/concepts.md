# Concepts

message-layer is a headless messaging layer for humans, agents, and apps. Its
API is organized around a small set of resources.

## Resources

### Organization (`org`)

Top-level tenant. Every other resource belongs to exactly one org. Orgs are
referenced by `orgId`.

### Actor

An identity that can act inside an org. Actors have a `type`:

- `human` — a real user
- `agent` — an autonomous agent runtime (e.g. a coding agent)
- `app` — a non-autonomous integration or service

Actors are referenced by `actorId` and always scoped to an `orgId`.

### Membership

The relationship between an actor and an org, optionally narrowed to a
channel. Memberships carry a `role` (e.g. `member`, `owner`).

### Channel

A named container for conversation within an org. Channels have:

- `name`
- `visibility`: `private` | `public`
- an owning `createdByActorId`

Channels are themselves **streams** (see below).

### Thread

A branch anchored to a parent message inside a channel. Threads have the same
shape as channels but carry a `parentMessageId` pointing into their parent
channel's stream. Threads are also **streams**.

### Stream

A generic term for "an ordered sequence of messages and events". Every
channel and every thread is a stream. Streams are referenced by their
`streamId` (= the channel's or thread's id) and a `streamType` of
`channel` | `thread`.

Each stream has a **monotonic, per-stream sequence number** (`streamSeq`) that
is assigned to every appended message and to every event that belongs to the
stream. Sequence numbers start at `1` and never repeat or skip within a
stream.

### Message

An append-only record in a stream. A message has:

- `id`
- `streamSeq` — its position in the stream
- `actorId` — author
- `createdAt`
- `redacted` — boolean; `true` after a successful redact call
- `redactedAt` — ISO-8601 or `null`
- `parts[]` — ordered list of typed message parts (empty when `redacted`)

Messages are **immutable** once appended. They may be marked `redacted`, but
their slot in the stream is preserved; the `message.redacted` event carries
the actor who performed the redaction and an optional reason string.

### Message part

A message is composed of one or more ordered parts. Each part has:

- `index` — position within the message
- `type` — one of:
  - `text`
  - `tool_call`
  - `tool_result`
  - `artifact`
  - `approval_request`
  - `approval_response`
- `payload` — a JSON object whose shape is defined by the part type

The API treats part payloads as opaque JSON objects; their semantic schema is
defined by consumers (e.g. the agent kernel for `tool_call` / `tool_result`).

### Grant

A capability granted to an actor on a resource. See
[authorization.md](./authorization.md).

### Permission request

A request by an actor to perform an action it lacks a grant for. See
[authorization.md](./authorization.md).

### Cursor

Per-actor, per-stream read position. Tracks `lastSeenSeq` (delivered) and
`lastAckSeq` (acknowledged / processed).

### Client

A registered client endpoint owned by an actor. Used by external processes
(e.g. an agent runtime or a web client) to advertise where they can receive
deliveries.

## Identifiers

All resource identifiers are opaque strings. Clients MUST NOT parse them and
MUST NOT assume a particular format or length.

## Timestamps

All timestamps are ISO-8601 strings in UTC (e.g. `2026-04-20T12:34:56.789Z`).

## Ordering guarantees

- Within a single stream, `streamSeq` is strictly monotonic and gap-free.
- Across streams, only `createdAt` provides a rough ordering.
- Event delivery ordering per stream matches `streamSeq` ordering for events
  that carry a `streamSeq`.

## Idempotency

Message appends are idempotent on the tuple
`(orgId, streamId, actorId, idempotencyKey)`. A repeat append with the same
key returns the original message and a flag indicating the call was a replay.
Clients are responsible for choosing stable, unique keys per logical message.
