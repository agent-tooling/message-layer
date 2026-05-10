# Telegram bridge

The Telegram bridge is a plugin transport that projects one Telegram bot/chat
to one human actor + one channel binding.

Message-layer remains canonical for:

- identity and actor model
- authorization and privacy checks
- message persistence and audit trail

Telegram is a client projection only.

## Core model

- A bridge is **not** a new actor type.
- Inbound Telegram messages append as the bound `human` actor.
- The principal provider used by the bridge is `bridge:telegram`.
- Transport metadata is attached to inbound text part payloads:
  - `transport: "telegram"`
  - `telegram: { setupId, updateId, messageId, chatId }`

## Scope (MVP)

Supported:

- one Telegram bot token per setup
- one Telegram private chat bound to one MessageLayer channel
- channel-level messaging only
- inbound text/caption projection
- outbound text projection from `message.appended`

Out of scope:

- Telegram group/supergroup/channel chats
- multi-channel routing in a single setup
- command/thread Telegram UX
- rich media parity

## Runtime configuration

Plugin options:

| Option | Type | Default | Description |
|---|---|---|---|
| `mountPath` | `string` | `"/v1/bridges/telegram"` | Base path for setup + webhook routes. |
| `publicBaseUrl` | `string` | `process.env.PUBLIC_BASE_URL` | Public HTTPS origin used to derive webhook URLs. |
| `webhookSecretSigningKey` | `string` | `process.env.TELEGRAM_WEBHOOK_SECRET_KEY` | Server secret used for per-setup webhook tokens and bot-token encryption. |
| `telegramApiBaseUrl` | `string` | `"https://api.telegram.org"` | Telegram Bot API base URL. |
| `requestTimeoutMs` | `number` | `5000` | Timeout for Telegram API calls. |

Derived webhook URL shape:

`{publicBaseUrl}{mountPath}/webhook/{setupId}`

## Plugin-owned data model

### `telegram_bridge_setups`

Bridge setup records and chat binding state.

- `status`: `pending_bind | active | disabled | error`
- `bot_token_encrypted`: encrypted token payload at rest
- `bound_chat_id` / `bound_chat_type`: populated on first successful bind

### `telegram_bridge_inbound_updates`

Inbound webhook dedupe + outcomes.

- dedupe key: `(setup_id, telegram_update_id)`
- status: `accepted | ignored | denied | error`

### `telegram_bridge_outbound_deliveries`

Outbound delivery tracking.

- dedupe key: `(setup_id, source_message_id)`
- status: `sent | failed`
- persists `attempt_count` and `last_error`

## HTTP API

All setup-management routes require `x-principal`.

### `POST /v1/bridges/telegram/setups`

Create setup and register Telegram webhook.

Request:

```json
{
  "humanActorId": "actor_human",
  "channelId": "channel_123",
  "botToken": "123456:ABC...",
  "autoBindOnFirstMessage": true
}
```

Behavior summary:

1. Validate principal/org membership.
2. Validate caller can manage setup (same human or `bridge:telegram:manage`).
3. Validate `humanActorId` is a human actor in org.
4. Validate human can read target channel.
5. Validate token via Telegram `getMe`.
6. Persist setup row.
7. Register webhook via Telegram `setWebhook`.

Response:

```json
{
  "setupId": "string",
  "status": "pending_bind",
  "webhookUrl": "https://.../v1/bridges/telegram/webhook/<setupId>",
  "bot": { "id": "777001", "username": "bridge_bot" }
}
```

### `GET /v1/bridges/telegram/setups`

List visible setups in org.

- managers (`bridge:telegram:manage`) see all org setups
- non-managers see only setups where `human_actor_id == principal.actorId`

### `GET /v1/bridges/telegram/setups/:setupId`

Get one setup (same visibility rules as list).

### `POST /v1/bridges/telegram/setups/:setupId/disable`

Disable setup and issue best-effort Telegram `deleteWebhook`.

### `POST /v1/bridges/telegram/setups/:setupId/rotate-webhook-secret`

Rotate webhook secret salt and re-register webhook with a new
`secret_token`.

## Webhook ingest contract

### `POST /v1/bridges/telegram/webhook/:setupId`

Authentication:

- Verify `X-Telegram-Bot-Api-Secret-Token` against per-setup expected token.
- Reject mismatch with `401`.

Inbound handling:

- Only Telegram `message` updates are considered.
- Only `chat.type == "private"` is accepted.
- Only text/caption updates are projected.
- Unsupported shapes return `200` with an `ignored` reason.

Dedupe:

- First insert wins in `telegram_bridge_inbound_updates` on
  `(setup_id, telegram_update_id)`.
- Duplicates return `200` with `{ duplicate: true }`.

Binding:

- First accepted inbound message binds `bound_chat_id` when unbound.
- If setup is already bound to a different chat, update is ignored.

Append:

- Bridge principal:
  - `actorId = human_actor_id`
  - `orgId = setup.org_id`
  - `scopes = []`
  - `provider = "bridge:telegram"`
- Append to bound channel via `service.appendMessage(...)`.
- Uses deterministic idempotency key:
  - `tg:{setupId}:{updateId}:{messageId}`
- Uses `autoRequestOnDeny: true`; denied outcomes are recorded as
  bridge-denied (not generic server errors).

## Outbound projection contract

Triggered by `message.appended` events:

1. Select active bound setups for `(org_id, channel_id)`.
2. Skip messages authored by the bound human actor (echo prevention).
3. Build Telegram text by concatenating text parts.
4. Fallback for non-text messages:
   - `[message contains non-text parts; view in message-layer]`
5. Send via Telegram `sendMessage`.
6. Persist/update delivery status in `telegram_bridge_outbound_deliveries`.

Delivery is best-effort in MVP (single immediate attempt, no background retry).

## Security and privacy

- Bot tokens are encrypted at rest in setup rows.
- Raw bot tokens are never returned by bridge APIs.
- Webhook secret comparison is constant-time.
- Inbound appends still go through core privacy/capability checks.
- Bridge delivery is explicit to the bound chat only (no implicit fanout).

## Testing guidance

Bridge changes should be validated with real HTTP boundaries:

- real message-layer service + DB + plugin runtime
- in-process fake Telegram HTTP server (not function mocks)
- no DB/service/HTTP mocks for core behavior

Current no-mock coverage:

- `tests/e2e/telegram-bridge.test.ts`
- `tests/e2e/plugins.test.ts`
- `tests/e2e/plugin-subpaths.test.ts`
