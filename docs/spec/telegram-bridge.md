# Telegram bridge (MVP proposal)

Status: **implemented (MVP)**

This document turns the Telegram bridge intent into an implementation-ready
spec that matches message-layer principles:

- message-layer remains the source of truth
- bridge is a transport/client projection, not a new actor type
- permissions/privacy are enforced by core service calls
- important actions are auditable and replay-safe

## 1) Goals and non-goals

### Goals (MVP)

1. One Telegram bot maps to one human actor + one channel.
2. Telegram inbound messages append to message-layer as that **human** actor.
3. Agent/app replies in that channel are projected back to the Telegram chat.
4. Setup is done through REST APIs plus manual BotFather bot creation.
5. Bridge delivery is explicit and bounded (no implicit org-wide routing).

### Non-goals (MVP)

- Group/supergroup/channel chat support.
- Multi-channel routing from one setup.
- Telegram command UX (`/commands`) and thread UX.
- Backfill of historical message-layer messages into Telegram.
- Rich media parity (stickers, files, polls) beyond basic text projection.

## 2) Core model fit

Bridge traffic is attributed as:

- `actorId` = human actor id
- `provider` = `"bridge:telegram"`
- transport metadata linked to the bridge setup and Telegram update/message ids

The bridge does **not** become an actor/participant and does not bypass
service-level authorization.

## 3) Required runtime config

The Telegram plugin requires:

- `publicBaseUrl` (HTTPS URL reachable by Telegram)
- `webhookSecretSigningKey` (server secret used to derive per-setup secret token)
- optional `mountPath` (default `/v1/bridges/telegram`)

Recommended env names:

- `PUBLIC_BASE_URL=https://your-vm-domain.example.com`
- `TELEGRAM_WEBHOOK_SECRET_KEY=<high-entropy-secret>`

Derived webhook URL:

`{PUBLIC_BASE_URL}/v1/bridges/telegram/webhook/{setupId}`

## 4) Data model (plugin-owned tables)

Plugin owns its schema (no direct mutation of core tables):

### `telegram_bridge_setups`

- `id` (pk)
- `org_id`
- `human_actor_id`
- `channel_id`
- `bot_token_encrypted`
- `bot_id` (from `getMe`)
- `bot_username`
- `status` (`pending_bind` | `active` | `disabled` | `error`)
- `bound_chat_id` (nullable until first inbound message)
- `bound_chat_type` (must be `"private"` in MVP)
- `created_at`, `updated_at`, `disabled_at`

Constraints:

- unique active setup per `(org_id, human_actor_id, channel_id)`
- unique `(bot_id, bound_chat_id)` among active setups

### `telegram_bridge_inbound_updates`

Dedup + traceability for at-least-once webhook delivery.

- `setup_id`
- `telegram_update_id`
- `telegram_message_id`
- `received_at`
- `status` (`accepted` | `ignored` | `denied` | `error`)
- `message_id` (message-layer id when accepted)
- unique `(setup_id, telegram_update_id)`

### `telegram_bridge_outbound_deliveries`

Idempotent projection to Telegram.

- `setup_id`
- `source_message_id` (message-layer message id)
- `telegram_chat_id`
- `telegram_message_id` (nullable on failure)
- `attempt_count`
- `last_error`
- `status` (`sent` | `failed`)
- unique `(setup_id, source_message_id)`

## 5) REST API contract

All management routes require `x-principal`.

### `POST /v1/bridges/telegram/setups`

Create a setup and register Telegram webhook.

Request body:

```json
{
  "humanActorId": "actor_human",
  "channelId": "channel_123",
  "botToken": "123456:ABC...",
  "autoBindOnFirstMessage": true
}
```

Behavior:

1. Validate principal can manage this bridge binding.
2. Validate `humanActorId` belongs to principal org and is `human`.
3. Validate channel exists and human can read it.
4. Call Telegram `getMe` with token.
5. Create setup row (`pending_bind`).
6. Derive per-setup secret token and call `setWebhook` with URL + secret.
7. Return setup metadata.

Response:

```json
{
  "setupId": "tg_setup_...",
  "status": "pending_bind",
  "webhookUrl": "https://.../v1/bridges/telegram/webhook/tg_setup_...",
  "bot": { "id": "123456", "username": "my_ml_bot" }
}
```

### `GET /v1/bridges/telegram/setups/:setupId`

Return setup status and binding details.

### `GET /v1/bridges/telegram/setups`

List setups visible to principal in org.

### `POST /v1/bridges/telegram/setups/:setupId/disable`

Disable bridge and call Telegram `deleteWebhook` (best-effort), preserving audit
history.

### `POST /v1/bridges/telegram/setups/:setupId/rotate-webhook-secret`

Rotate secret token; re-issues `setWebhook`.

## 6) Webhook endpoint contract

### `POST /v1/bridges/telegram/webhook/:setupId`

Auth:

- Verify `X-Telegram-Bot-Api-Secret-Token` in constant time.
- Reject on mismatch (`401`).

Inbound acceptance (MVP):

- Accept only updates containing `message`.
- Accept only `chat.type === "private"`.
- Accept text-like payloads (`text`, optionally `caption`).
- Ignore unsupported updates with `200` (Telegram should not retry ignored types).

Idempotency:

- Dedup by `(setup_id, update_id)`.
- If already processed, return `200` without re-appending.

First-message binding:

- If `bound_chat_id` is null, set it from first accepted message.
- If bound and incoming chat differs, ignore and log mismatch.

Append behavior:

1. Build principal:
   - `actorId = human_actor_id`
   - `orgId = setup.org_id`
   - `scopes = []`
   - `provider = "bridge:telegram"`
2. Call `service.appendMessage(...)` into bound `channel_id`.
3. Use idempotency key:
   - `tg:{setupId}:{updateId}:{messageId}`

On permission deny:

- Record `denied` inbound status.
- Do not retry append.
- Optionally send one Telegram notice: "Message not delivered: missing permission."

## 7) Outbound projection contract

Outbound is event-driven from `message.appended`:

1. Filter to setups where `status=active` and `channel_id == event.streamId`.
2. Skip events authored by the same human actor (prevents echo in one-chat MVP).
3. Build Telegram text projection from message parts:
   - include `text` parts in order
   - join with `\n\n`
   - fallback string for non-text-only messages:
     - `"[message contains non-text parts; view in message-layer]"`
4. Send via Telegram `sendMessage(chat_id, text)`.
5. Upsert `telegram_bridge_outbound_deliveries` with dedupe key
   `(setup_id, source_message_id)`.

Retry policy (MVP):

- No background retry worker required.
- One immediate attempt per event.
- Persist failure reason for operator visibility.

## 8) Authorization + privacy rules

Management routes require one of:

- principal is the same `humanActorId`, or
- principal has org-level bridge management capability (recommended:
  `bridge:telegram:manage`).

Inbound appends never bypass core checks:

- stream must be readable by human actor
- human must hold `message:append` (scope/grant)
- private channel membership remains enforced in `MessageLayer`

Derived/bridged data visibility:

- Telegram output is only for the explicitly bound chat and channel.
- No org-wide fanout.

## 9) Audit and observability notes

Inbound bridge appends include transport metadata in the text part payload:
`payload.transport = "telegram"` plus a `payload.telegram` object carrying
`setupId`, `updateId`, `messageId`, and `chatId`.

Plugin-owned tables also persist delivery outcomes:

- `telegram_bridge_inbound_updates`
- `telegram_bridge_outbound_deliveries`

Minimum required logs:

- setup created/disabled/rotated
- chat bound
- inbound accepted/denied/ignored/error
- outbound sent/failed

## 10) Security requirements

- Encrypt bot token at rest (plugin-level encrypted column or KMS-backed adapter).
- Never log raw bot token.
- Validate webhook secret token on every request.
- Constant-time comparison for secret token.
- Optional: reject webhook when source ASN/IP is clearly invalid (soft defense).
- Honor global API-key plugin if deployed (`api-key-header-auth`) for management
  routes; webhook route remains Telegram-authenticated via secret token.

## 11) Test plan (must be no-mock for core)

### Unit-level plugin tests

- setup creation stores encrypted token and calls Telegram API wrapper.
- webhook secret verification success/failure.
- inbound dedupe on repeated `update_id`.
- first-message binding and mismatched-chat rejection.
- outbound dedupe per source message id.

### E2E tests (`tests/e2e/plugins.test.ts`)

Run real HTTP app + real service + real event bus + plugin schema:

1. Create org/actors/channel.
2. Create Telegram setup (Telegram HTTP mocked only at plugin boundary wrapper).
3. POST webhook update; assert channel message appears via
   `GET /v1/streams/:id/messages`.
4. Append an agent message in channel; assert plugin attempts Telegram send and
   stores delivery row.
5. Verify private-channel membership and `message:append` denial behavior.

## 12) MVP acceptance criteria

1. User creates bot in BotFather and calls setup API with token.
2. Setup returns webhook URL and `pending_bind`.
3. User sends first message to bot; setup becomes `active` and binds chat.
4. Telegram message appears as a message-layer channel message from human actor,
   via provider `bridge:telegram`.
5. Agent/app reply in channel is delivered to same Telegram chat.
6. Duplicate Telegram updates do not produce duplicate message-layer messages.
7. Audit/bridge logs show actor + transport attribution for both directions.

