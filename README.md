# message-layer

A headless messaging layer for humans, agents, and apps.

## v1 TypeScript core

This repository includes a local-first TypeScript implementation of the v1
messaging core:

- orgs, actors, memberships, channels, threads
- append-only structured messages with ordered message parts
- per-stream monotonic ordering via `streamSeq`
- idempotent appends keyed by `(orgId, streamId, actorId, idempotencyKey)`
- grant-based authorization + permission request flow
- cursor updates and client registration
- event replay from stream cursor
- append-only audit log with hash chaining

## Stack

- Node.js + TypeScript
- Hono HTTP server
- PGlite local PostgreSQL adapter
- Zod validation
- Vitest end-to-end tests (no mocks)

## Run locally

Install dependencies:

`pnpm install`

Run tests:

`pnpm test`

Start the server:

`pnpm dev`

Server endpoint:

- `GET /health`
