# Terminal client (minimal TUI)

This client wraps the core HTTP API with a minimal interactive terminal UI so
you can explore server behavior quickly while building/testing the core.

## Run

Start the server first:

`pnpm dev`

Then launch the terminal UI:

`pnpm client:terminal`

Optional env vars:

- `MESSAGE_LAYER_BASE_URL` (default: `http://127.0.0.1:3000`)

## What it supports

- create org
- create actor
- select active principal
- create channel/thread
- append/list/subscribe messages
- update cursor
- create/revoke grant
- create/resolve permission request
- register client

