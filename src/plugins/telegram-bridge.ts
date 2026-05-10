import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { PermissionError, ValidationError, principalSchema, type DomainEvent, type Principal } from "../types.js";
import type { ServerPlugin } from "../plugins.js";

type TelegramBridgeSetupRow = {
  id: string;
  org_id: string;
  human_actor_id: string;
  channel_id: string;
  bot_token_encrypted: string;
  bot_id: string;
  bot_username: string | null;
  status: "pending_bind" | "active" | "disabled" | "error";
  bound_chat_id: string | null;
  bound_chat_type: string | null;
  auto_bind_on_first_message: number;
  webhook_secret_salt: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
};

type TelegramInboundRow = {
  id: string;
};

const createSetupBody = z.object({
  humanActorId: z.string().min(1),
  channelId: z.string().min(1),
  botToken: z.string().min(8),
  autoBindOnFirstMessage: z.boolean().optional(),
});

const setupIdParam = z.object({ setupId: z.string().min(1) });

const telegramGetMeResultSchema = z.object({
  id: z.union([z.number(), z.string()]).transform((value) => String(value)),
  username: z.string().nullable().optional(),
});

const telegramSendMessageResultSchema = z.object({
  message_id: z.union([z.number(), z.string()]).transform((value) => String(value)),
});

const telegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      message_id: z.number().int(),
      text: z.string().optional(),
      caption: z.string().optional(),
      chat: z.object({
        id: z.union([z.number(), z.string()]).transform((value) => String(value)),
        type: z.string(),
      }),
    })
    .optional(),
});

type TelegramCallOptions = {
  apiBaseUrl: string;
  token: string;
  method: string;
  payload: Record<string, unknown>;
  timeoutMs: number;
};

function parsePrincipal(headerValue: string | undefined): Principal | null {
  if (!headerValue) return null;
  try {
    const parsed = JSON.parse(headerValue);
    const result = principalSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function assertPrincipalInOrg(
  principal: Principal,
  query: (sql: string, params?: Array<string | number | null>) => Promise<{ rows: Array<{ ok: number }> }>,
): Promise<void> {
  const row = await query(
    "SELECT 1 AS ok FROM actors WHERE id=? AND org_id=? LIMIT 1",
    [principal.actorId, principal.orgId],
  );
  if (!row.rows[0]) {
    throw new PermissionError("actor is not in org");
  }
}

async function hasManageCapability(
  principal: Principal,
  serviceHasGrant: (orgId: string, actorId: string, capability: string) => Promise<boolean>,
): Promise<boolean> {
  if (principal.scopes.includes("bridge:telegram:manage")) return true;
  return serviceHasGrant(principal.orgId, principal.actorId, "bridge:telegram:manage");
}

async function assertCanManageSetup(
  principal: Principal,
  humanActorId: string,
  serviceHasGrant: (orgId: string, actorId: string, capability: string) => Promise<boolean>,
): Promise<void> {
  if (principal.actorId === humanActorId) return;
  if (await hasManageCapability(principal, serviceHasGrant)) return;
  throw new PermissionError("missing bridge:telegram:manage");
}

function deriveEncryptionKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function encryptToken(token: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

function decryptToken(encoded: string, key: Buffer): string {
  const [version, ivRaw, tagRaw, payloadRaw] = encoded.split(":");
  if (version !== "v1" || !ivRaw || !tagRaw || !payloadRaw) {
    throw new ValidationError("invalid encrypted bot token format");
  }
  const iv = Buffer.from(ivRaw, "base64url");
  const tag = Buffer.from(tagRaw, "base64url");
  const encrypted = Buffer.from(payloadRaw, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return plaintext.toString("utf8");
}

function computeWebhookSecret(signingKey: string, setupId: string, secretSalt: string): string {
  return createHmac("sha256", signingKey).update(`telegram:${setupId}:${secretSalt}`).digest("hex");
}

function secureEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

function errorResponse(error: unknown): Response {
  if (error instanceof PermissionError) {
    return new Response(JSON.stringify({ error: error.message, code: "PERMISSION_DENIED" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  if (error instanceof ValidationError || error instanceof z.ZodError) {
    return new Response(JSON.stringify({ error: "invalid request", code: "VALIDATION" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (error instanceof Error) {
    return new Response(JSON.stringify({ error: error.message, code: "ERROR" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ error: "unexpected error", code: "ERROR" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

async function telegramCall(options: TelegramCallOptions): Promise<Record<string, unknown>> {
  const endpoint = `${options.apiBaseUrl.replace(/\/+$/, "")}/bot${options.token}/${options.method}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options.payload),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new ValidationError(`telegram ${options.method} returned non-json response`);
  }
  if (!response.ok) {
    throw new ValidationError(`telegram ${options.method} failed with status ${response.status}`);
  }
  if (json.ok !== true) {
    const description = typeof json.description === "string" ? `: ${json.description}` : "";
    throw new ValidationError(`telegram ${options.method} returned ok=false${description}`);
  }
  return json;
}

function extractTelegramResult<T>(
  payload: Record<string, unknown>,
  schema: z.ZodType<T>,
  method: string,
): T {
  const parsed = schema.safeParse(payload.result);
  if (!parsed.success) {
    throw new ValidationError(`telegram ${method} result payload invalid`);
  }
  return parsed.data;
}

function buildWebhookUrl(publicBaseUrl: string, mountPath: string, setupId: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}${mountPath}/webhook/${setupId}`;
}

function parseJsonRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    if (raw.length === 0) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function composeTelegramText(rows: Array<{ part_type: string; payload_json: unknown }>): string {
  const textParts: string[] = [];
  for (const row of rows) {
    if (row.part_type !== "text") continue;
    const payload = parseJsonRecord(row.payload_json);
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (text.length > 0) textParts.push(text);
  }
  const merged =
    textParts.length > 0 ? textParts.join("\n\n") : "[message contains non-text parts; view in message-layer]";
  return merged.length <= 4096 ? merged : `${merged.slice(0, 4093)}...`;
}

async function updateInboundStatus(
  query: (sql: string, params?: Array<string | number | null>) => Promise<unknown>,
  setupId: string,
  updateId: number,
  status: "accepted" | "ignored" | "denied" | "error",
  options: { messageId?: string; error?: string } = {},
): Promise<void> {
  await query(
    `UPDATE telegram_bridge_inbound_updates
       SET status=?, message_id=?, error_message=?
     WHERE setup_id=? AND telegram_update_id=?`,
    [status, options.messageId ?? null, options.error ?? null, setupId, updateId],
  );
}

export function telegramBridgePlugin(options?: Record<string, unknown>): ServerPlugin {
  const mountPath = typeof options?.mountPath === "string" ? options.mountPath : "/v1/bridges/telegram";
  const telegramApiBaseUrl = typeof options?.telegramApiBaseUrl === "string"
    ? options.telegramApiBaseUrl
    : "https://api.telegram.org";
  const requestTimeoutMs = Number(options?.requestTimeoutMs ?? 5000);

  return {
    name: "telegram-bridge",
    schemaSql: {
      name: "telegram-bridge",
      sql: [
        `CREATE TABLE IF NOT EXISTS telegram_bridge_setups (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL,
          human_actor_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          bot_token_encrypted TEXT NOT NULL,
          bot_id TEXT NOT NULL,
          bot_username TEXT,
          status TEXT NOT NULL CHECK (status IN ('pending_bind','active','disabled','error')),
          bound_chat_id TEXT,
          bound_chat_type TEXT,
          auto_bind_on_first_message INTEGER NOT NULL DEFAULT 1,
          webhook_secret_salt TEXT NOT NULL,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          disabled_at TEXT,
          FOREIGN KEY (org_id) REFERENCES organizations(id),
          FOREIGN KEY (human_actor_id) REFERENCES actors(id),
          FOREIGN KEY (channel_id) REFERENCES channels(id)
        )`,
        "CREATE INDEX IF NOT EXISTS idx_telegram_bridge_setups_org ON telegram_bridge_setups(org_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_telegram_bridge_setups_channel ON telegram_bridge_setups(org_id, channel_id)",
        "CREATE INDEX IF NOT EXISTS idx_telegram_bridge_setups_human ON telegram_bridge_setups(org_id, human_actor_id)",
        "CREATE INDEX IF NOT EXISTS idx_telegram_bridge_setups_bot_chat ON telegram_bridge_setups(bot_id, bound_chat_id, status)",
        `CREATE TABLE IF NOT EXISTS telegram_bridge_inbound_updates (
          id TEXT PRIMARY KEY,
          setup_id TEXT NOT NULL,
          telegram_update_id BIGINT NOT NULL,
          telegram_message_id BIGINT,
          status TEXT NOT NULL CHECK (status IN ('accepted','ignored','denied','error')),
          message_id TEXT,
          error_message TEXT,
          received_at TEXT NOT NULL,
          UNIQUE (setup_id, telegram_update_id),
          FOREIGN KEY (setup_id) REFERENCES telegram_bridge_setups(id)
        )`,
        "CREATE INDEX IF NOT EXISTS idx_telegram_bridge_inbound_setup ON telegram_bridge_inbound_updates(setup_id, received_at)",
        `CREATE TABLE IF NOT EXISTS telegram_bridge_outbound_deliveries (
          id TEXT PRIMARY KEY,
          setup_id TEXT NOT NULL,
          source_message_id TEXT NOT NULL,
          telegram_chat_id TEXT NOT NULL,
          telegram_message_id TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          status TEXT NOT NULL CHECK (status IN ('sent','failed')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (setup_id, source_message_id),
          FOREIGN KEY (setup_id) REFERENCES telegram_bridge_setups(id)
        )`,
        "CREATE INDEX IF NOT EXISTS idx_telegram_bridge_outbound_setup ON telegram_bridge_outbound_deliveries(setup_id, created_at)",
      ],
    },
    registerRoutes(ctx) {
      const publicBaseUrl = typeof options?.publicBaseUrl === "string"
        ? options.publicBaseUrl
        : ctx.env.PUBLIC_BASE_URL;
      const webhookSecretSigningKey = typeof options?.webhookSecretSigningKey === "string"
        ? options.webhookSecretSigningKey
        : ctx.env.TELEGRAM_WEBHOOK_SECRET_KEY;
      if (!publicBaseUrl) {
        throw new Error("telegram-bridge requires publicBaseUrl (or PUBLIC_BASE_URL)");
      }
      if (!webhookSecretSigningKey) {
        throw new Error(
          "telegram-bridge requires webhookSecretSigningKey (or TELEGRAM_WEBHOOK_SECRET_KEY)",
        );
      }
      const resolvedPublicBaseUrl = publicBaseUrl;
      const resolvedWebhookSecretSigningKey = webhookSecretSigningKey;
      const encryptionKey = deriveEncryptionKey(webhookSecretSigningKey);

      async function loadSetup(setupId: string): Promise<TelegramBridgeSetupRow | null> {
        const rows = await ctx.db.query<TelegramBridgeSetupRow>(
          `SELECT id,org_id,human_actor_id,channel_id,bot_token_encrypted,bot_id,bot_username,status,bound_chat_id,
                  bound_chat_type,auto_bind_on_first_message,webhook_secret_salt,last_error,created_at,updated_at,disabled_at
             FROM telegram_bridge_setups
            WHERE id=?`,
          [setupId],
        );
        return rows.rows[0] ?? null;
      }

      function setupView(row: TelegramBridgeSetupRow): Record<string, unknown> {
        return {
          setupId: row.id,
          orgId: row.org_id,
          humanActorId: row.human_actor_id,
          channelId: row.channel_id,
          bot: {
            id: row.bot_id,
            username: row.bot_username,
          },
          status: row.status,
          boundChatId: row.bound_chat_id,
          boundChatType: row.bound_chat_type,
          autoBindOnFirstMessage: row.auto_bind_on_first_message === 1,
          lastError: row.last_error,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          disabledAt: row.disabled_at,
          webhookUrl: buildWebhookUrl(resolvedPublicBaseUrl, mountPath, row.id),
        };
      }

      ctx.app.post(`${mountPath}/setups`, async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) {
          return c.json({ error: "missing or invalid principal", code: "UNAUTHORIZED" }, 401);
        }
        try {
          await assertPrincipalInOrg(principal, ctx.db.query.bind(ctx.db));
          const body = createSetupBody.parse(await c.req.json());
          await assertCanManageSetup(principal, body.humanActorId, ctx.service.checkGrant.bind(ctx.service));
          const human = await ctx.db.query<{ id: string }>(
            "SELECT id FROM actors WHERE id=? AND org_id=? AND type='human' LIMIT 1",
            [body.humanActorId, principal.orgId],
          );
          if (!human.rows[0]) {
            throw new ValidationError("humanActorId must reference a human actor in principal org");
          }
          await ctx.service.assertCanReadStream(
            {
              actorId: body.humanActorId,
              orgId: principal.orgId,
              scopes: [],
              provider: "bridge:telegram",
            },
            body.channelId,
            "channel",
          );
          const existing = await ctx.db.query<{ id: string }>(
            `SELECT id FROM telegram_bridge_setups
              WHERE org_id=? AND human_actor_id=? AND channel_id=? AND status IN ('pending_bind','active')
              LIMIT 1`,
            [principal.orgId, body.humanActorId, body.channelId],
          );
          if (existing.rows[0]) {
            return c.json(
              {
                error: "an active or pending setup already exists for this human/channel pair",
                code: "CONFLICT",
              },
              409,
            );
          }
          const getMePayload = await telegramCall({
            apiBaseUrl: telegramApiBaseUrl,
            token: body.botToken,
            method: "getMe",
            payload: {},
            timeoutMs: requestTimeoutMs,
          });
          const bot = extractTelegramResult(getMePayload, telegramGetMeResultSchema, "getMe");
          const setupId = randomUUID().replaceAll("-", "");
          const now = new Date().toISOString();
          const secretSalt = randomBytes(16).toString("hex");
          await ctx.db.query(
            `INSERT INTO telegram_bridge_setups(
               id,org_id,human_actor_id,channel_id,bot_token_encrypted,bot_id,bot_username,status,bound_chat_id,bound_chat_type,
               auto_bind_on_first_message,webhook_secret_salt,last_error,created_at,updated_at,disabled_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              setupId,
              principal.orgId,
              body.humanActorId,
              body.channelId,
              encryptToken(body.botToken, encryptionKey),
              bot.id,
              bot.username ?? null,
              "pending_bind",
              null,
              null,
              body.autoBindOnFirstMessage === false ? 0 : 1,
              secretSalt,
              null,
              now,
              now,
              null,
            ],
          );
          const webhookUrl = buildWebhookUrl(resolvedPublicBaseUrl, mountPath, setupId);
          const secretToken = computeWebhookSecret(resolvedWebhookSecretSigningKey, setupId, secretSalt);
          try {
            await telegramCall({
              apiBaseUrl: telegramApiBaseUrl,
              token: body.botToken,
              method: "setWebhook",
              payload: { url: webhookUrl, secret_token: secretToken, allowed_updates: ["message"] },
              timeoutMs: requestTimeoutMs,
            });
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            await ctx.db.query(
              "UPDATE telegram_bridge_setups SET status='error', last_error=?, updated_at=? WHERE id=?",
              [reason, new Date().toISOString(), setupId],
            );
            throw error;
          }
          return c.json({
            setupId,
            status: "pending_bind",
            webhookUrl,
            bot: {
              id: bot.id,
              username: bot.username ?? null,
            },
          });
        } catch (error) {
          return errorResponse(error);
        }
      });

      ctx.app.get(`${mountPath}/setups`, async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) {
          return c.json({ error: "missing or invalid principal", code: "UNAUTHORIZED" }, 401);
        }
        try {
          await assertPrincipalInOrg(principal, ctx.db.query.bind(ctx.db));
          const canManageAll = await hasManageCapability(principal, ctx.service.checkGrant.bind(ctx.service));
          const rows = canManageAll
            ? await ctx.db.query<TelegramBridgeSetupRow>(
                `SELECT id,org_id,human_actor_id,channel_id,bot_token_encrypted,bot_id,bot_username,status,bound_chat_id,
                        bound_chat_type,auto_bind_on_first_message,webhook_secret_salt,last_error,created_at,updated_at,disabled_at
                   FROM telegram_bridge_setups
                  WHERE org_id=?
                  ORDER BY created_at DESC`,
                [principal.orgId],
              )
            : await ctx.db.query<TelegramBridgeSetupRow>(
                `SELECT id,org_id,human_actor_id,channel_id,bot_token_encrypted,bot_id,bot_username,status,bound_chat_id,
                        bound_chat_type,auto_bind_on_first_message,webhook_secret_salt,last_error,created_at,updated_at,disabled_at
                   FROM telegram_bridge_setups
                  WHERE org_id=? AND human_actor_id=?
                  ORDER BY created_at DESC`,
                [principal.orgId, principal.actorId],
              );
          return c.json({ setups: rows.rows.map((row) => setupView(row)) });
        } catch (error) {
          return errorResponse(error);
        }
      });

      ctx.app.get(`${mountPath}/setups/:setupId`, async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) {
          return c.json({ error: "missing or invalid principal", code: "UNAUTHORIZED" }, 401);
        }
        try {
          await assertPrincipalInOrg(principal, ctx.db.query.bind(ctx.db));
          const params = setupIdParam.parse(c.req.param());
          const setup = await loadSetup(params.setupId);
          if (!setup || setup.org_id !== principal.orgId) {
            return c.json({ error: "setup not found", code: "NOT_FOUND" }, 404);
          }
          await assertCanManageSetup(principal, setup.human_actor_id, ctx.service.checkGrant.bind(ctx.service));
          return c.json({ setup: setupView(setup) });
        } catch (error) {
          return errorResponse(error);
        }
      });

      ctx.app.post(`${mountPath}/setups/:setupId/disable`, async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) {
          return c.json({ error: "missing or invalid principal", code: "UNAUTHORIZED" }, 401);
        }
        try {
          await assertPrincipalInOrg(principal, ctx.db.query.bind(ctx.db));
          const params = setupIdParam.parse(c.req.param());
          const setup = await loadSetup(params.setupId);
          if (!setup || setup.org_id !== principal.orgId) {
            return c.json({ error: "setup not found", code: "NOT_FOUND" }, 404);
          }
          await assertCanManageSetup(principal, setup.human_actor_id, ctx.service.checkGrant.bind(ctx.service));
          if (setup.status !== "disabled") {
            try {
              const token = decryptToken(setup.bot_token_encrypted, encryptionKey);
              await telegramCall({
                apiBaseUrl: telegramApiBaseUrl,
                token,
                method: "deleteWebhook",
                payload: { drop_pending_updates: false },
                timeoutMs: requestTimeoutMs,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              ctx.logger(`[telegram-bridge] deleteWebhook failed for ${setup.id}: ${message}`);
            }
            const now = new Date().toISOString();
            await ctx.db.query(
              "UPDATE telegram_bridge_setups SET status='disabled', disabled_at=?, updated_at=?, last_error=NULL WHERE id=?",
              [now, now, setup.id],
            );
          }
          const updated = await loadSetup(setup.id);
          if (!updated) return c.json({ error: "setup not found", code: "NOT_FOUND" }, 404);
          return c.json({ ok: true, setup: setupView(updated) });
        } catch (error) {
          return errorResponse(error);
        }
      });

      ctx.app.post(`${mountPath}/setups/:setupId/rotate-webhook-secret`, async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) {
          return c.json({ error: "missing or invalid principal", code: "UNAUTHORIZED" }, 401);
        }
        try {
          await assertPrincipalInOrg(principal, ctx.db.query.bind(ctx.db));
          const params = setupIdParam.parse(c.req.param());
          const setup = await loadSetup(params.setupId);
          if (!setup || setup.org_id !== principal.orgId) {
            return c.json({ error: "setup not found", code: "NOT_FOUND" }, 404);
          }
          await assertCanManageSetup(principal, setup.human_actor_id, ctx.service.checkGrant.bind(ctx.service));
          if (setup.status === "disabled") {
            return c.json({ error: "setup is disabled", code: "VALIDATION" }, 400);
          }
          const token = decryptToken(setup.bot_token_encrypted, encryptionKey);
          const nextSalt = randomBytes(16).toString("hex");
          const webhookUrl = buildWebhookUrl(resolvedPublicBaseUrl, mountPath, setup.id);
          const secretToken = computeWebhookSecret(resolvedWebhookSecretSigningKey, setup.id, nextSalt);
          await telegramCall({
            apiBaseUrl: telegramApiBaseUrl,
            token,
            method: "setWebhook",
            payload: { url: webhookUrl, secret_token: secretToken, allowed_updates: ["message"] },
            timeoutMs: requestTimeoutMs,
          });
          await ctx.db.query(
            "UPDATE telegram_bridge_setups SET webhook_secret_salt=?, updated_at=?, last_error=NULL WHERE id=?",
            [nextSalt, new Date().toISOString(), setup.id],
          );
          const updated = await loadSetup(setup.id);
          if (!updated) return c.json({ error: "setup not found", code: "NOT_FOUND" }, 404);
          return c.json({ ok: true, setup: setupView(updated) });
        } catch (error) {
          return errorResponse(error);
        }
      });

      ctx.app.post(`${mountPath}/webhook/:setupId`, async (c) => {
        const params = setupIdParam.safeParse(c.req.param());
        if (!params.success) {
          return c.json({ error: "invalid setup id", code: "VALIDATION" }, 400);
        }
        const setup = await loadSetup(params.data.setupId);
        if (!setup) {
          return c.json({ error: "setup not found", code: "NOT_FOUND" }, 404);
        }
        if (setup.status === "disabled") {
          return c.json({ ok: true, ignored: true, reason: "setup-disabled" }, 200);
        }

        const suppliedSecret = c.req.header("x-telegram-bot-api-secret-token") ?? "";
        const expectedSecret = computeWebhookSecret(
          resolvedWebhookSecretSigningKey,
          setup.id,
          setup.webhook_secret_salt,
        );
        if (!secureEquals(suppliedSecret, expectedSecret)) {
          return c.json({ error: "invalid webhook secret", code: "UNAUTHORIZED" }, 401);
        }

        let parsedUpdate: z.infer<typeof telegramUpdateSchema>;
        try {
          parsedUpdate = telegramUpdateSchema.parse(await c.req.json());
        } catch {
          return c.json({ ok: true, ignored: true, reason: "invalid-update-shape" }, 200);
        }

        const reserve = await ctx.db.query<TelegramInboundRow>(
          `INSERT INTO telegram_bridge_inbound_updates(
             id,setup_id,telegram_update_id,telegram_message_id,status,message_id,error_message,received_at
           ) VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT (setup_id, telegram_update_id) DO NOTHING
           RETURNING id`,
          [
            randomUUID().replaceAll("-", ""),
            setup.id,
            parsedUpdate.update_id,
            parsedUpdate.message?.message_id ?? null,
            "ignored",
            null,
            null,
            new Date().toISOString(),
          ],
        );
        if (!reserve.rows[0]) {
          return c.json({ ok: true, duplicate: true });
        }

        const finish = async (
          status: "accepted" | "ignored" | "denied" | "error",
          opts: { messageId?: string; error?: string } = {},
        ) => {
          await updateInboundStatus(
            ctx.db.query.bind(ctx.db),
            setup.id,
            parsedUpdate.update_id,
            status,
            opts,
          );
        };

        try {
          const inboundMessage = parsedUpdate.message;
          if (!inboundMessage) {
            await finish("ignored", { error: "missing-message" });
            return c.json({ ok: true, ignored: true, reason: "missing-message" });
          }
          if (inboundMessage.chat.type !== "private") {
            await finish("ignored", { error: "unsupported-chat-type" });
            return c.json({ ok: true, ignored: true, reason: "unsupported-chat-type" });
          }
          const text = (inboundMessage.text ?? inboundMessage.caption ?? "").trim();
          if (!text) {
            await finish("ignored", { error: "missing-text" });
            return c.json({ ok: true, ignored: true, reason: "missing-text" });
          }

          const chatId = inboundMessage.chat.id;
          if (!setup.bound_chat_id) {
            if (setup.auto_bind_on_first_message !== 1) {
              await finish("denied", { error: "auto-bind-disabled" });
              return c.json({ ok: true, denied: true, reason: "auto-bind-disabled" });
            }
            const chatConflict = await ctx.db.query<{ id: string }>(
              `SELECT id FROM telegram_bridge_setups
                WHERE bot_id=? AND bound_chat_id=? AND status='active' AND id<>?
                LIMIT 1`,
              [setup.bot_id, chatId, setup.id],
            );
            if (chatConflict.rows[0]) {
              await finish("ignored", { error: "chat-already-bound" });
              return c.json({ ok: true, ignored: true, reason: "chat-already-bound" });
            }
            await ctx.db.query(
              "UPDATE telegram_bridge_setups SET bound_chat_id=?, bound_chat_type='private', status='active', updated_at=?, last_error=NULL WHERE id=?",
              [chatId, new Date().toISOString(), setup.id],
            );
            setup.bound_chat_id = chatId;
            setup.bound_chat_type = "private";
            setup.status = "active";
          } else if (setup.bound_chat_id !== chatId) {
            await finish("ignored", { error: "chat-mismatch" });
            return c.json({ ok: true, ignored: true, reason: "chat-mismatch" });
          }

          const principal: Principal = {
            actorId: setup.human_actor_id,
            orgId: setup.org_id,
            scopes: [],
            provider: "bridge:telegram",
          };
          const append = await ctx.service.appendMessage(principal, {
            streamId: setup.channel_id,
            streamType: "channel",
            parts: [
              {
                type: "text",
                payload: {
                  text,
                  transport: "telegram",
                  telegram: {
                    setupId: setup.id,
                    updateId: parsedUpdate.update_id,
                    messageId: inboundMessage.message_id,
                    chatId,
                  },
                },
              },
            ],
            idempotencyKey: `tg:${setup.id}:${parsedUpdate.update_id}:${inboundMessage.message_id}`,
            autoRequestOnDeny: true,
          });
          if ("denied" in append && append.denied) {
            await finish("denied", { error: "message-append-denied" });
            return c.json({
              ok: true,
              denied: true,
              reason: "message-append-denied",
              requestId: append.requestId,
            });
          }
          await finish("accepted", { messageId: append.messageId });
          return c.json({ ok: true, messageId: append.messageId });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await finish("error", { error: reason });
          return c.json({ ok: true, error: "internal-error" }, 200);
        }
      });
    },
    async onEvent(event, ctx) {
      if (event.type !== "message.appended") return;
      const messageId = typeof event.payload.messageId === "string" ? event.payload.messageId : null;
      const authorActorId = typeof event.payload.actorId === "string" ? event.payload.actorId : null;
      const channelId = event.streamId;
      if (!messageId || !authorActorId || !channelId) return;
      const rows = await ctx.db.query<TelegramBridgeSetupRow>(
        `SELECT id,org_id,human_actor_id,channel_id,bot_token_encrypted,bot_id,bot_username,status,bound_chat_id,
                bound_chat_type,auto_bind_on_first_message,webhook_secret_salt,last_error,created_at,updated_at,disabled_at
           FROM telegram_bridge_setups
          WHERE org_id=? AND channel_id=? AND status='active' AND bound_chat_id IS NOT NULL`,
        [event.orgId, channelId],
      );
      if (rows.rows.length === 0) return;

      const webhookSecretSigningKey = typeof options?.webhookSecretSigningKey === "string"
        ? options.webhookSecretSigningKey
        : ctx.env.TELEGRAM_WEBHOOK_SECRET_KEY;
      if (!webhookSecretSigningKey) {
        ctx.logger("[telegram-bridge] missing TELEGRAM_WEBHOOK_SECRET_KEY; skipping outbound delivery");
        return;
      }
      const encryptionKey = deriveEncryptionKey(webhookSecretSigningKey);

      const partsRows = await ctx.db.query<{ part_type: string; payload_json: unknown }>(
        "SELECT part_type,payload_json FROM message_parts WHERE message_id=? ORDER BY part_index ASC",
        [messageId],
      );
      const text = composeTelegramText(partsRows.rows);

      const deliveries = rows.rows.map(async (setup) => {
        if (setup.human_actor_id === authorActorId) return;
        const reserved = await ctx.db.query<{ id: string }>(
          `INSERT INTO telegram_bridge_outbound_deliveries(
             id,setup_id,source_message_id,telegram_chat_id,telegram_message_id,attempt_count,last_error,status,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (setup_id, source_message_id) DO NOTHING
           RETURNING id`,
          [
            randomUUID().replaceAll("-", ""),
            setup.id,
            messageId,
            setup.bound_chat_id,
            null,
            0,
            null,
            "failed",
            new Date().toISOString(),
            new Date().toISOString(),
          ],
        );
        if (!reserved.rows[0]) return;

        try {
          const token = decryptToken(setup.bot_token_encrypted, encryptionKey);
          const responsePayload = await telegramCall({
            apiBaseUrl: telegramApiBaseUrl,
            token,
            method: "sendMessage",
            payload: { chat_id: setup.bound_chat_id, text },
            timeoutMs: requestTimeoutMs,
          });
          const sent = extractTelegramResult(responsePayload, telegramSendMessageResultSchema, "sendMessage");
          await ctx.db.query(
            `UPDATE telegram_bridge_outbound_deliveries
               SET telegram_message_id=?, attempt_count=attempt_count+1, status='sent', last_error=NULL, updated_at=?
             WHERE setup_id=? AND source_message_id=?`,
            [sent.message_id, new Date().toISOString(), setup.id, messageId],
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await ctx.db.query(
            `UPDATE telegram_bridge_outbound_deliveries
               SET attempt_count=attempt_count+1, status='failed', last_error=?, updated_at=?
             WHERE setup_id=? AND source_message_id=?`,
            [reason, new Date().toISOString(), setup.id, messageId],
          );
          await ctx.db.query(
            "UPDATE telegram_bridge_setups SET last_error=?, updated_at=? WHERE id=?",
            [reason, new Date().toISOString(), setup.id],
          );
        }
      });
      await Promise.allSettled(deliveries);
    },
  };
}
