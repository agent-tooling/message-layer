import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type TelegramMethod = "getMe" | "setWebhook" | "deleteWebhook" | "sendMessage";

type TelegramBot = {
  id: string;
  username: string;
};

type MethodCall = {
  method: TelegramMethod;
  token: string;
  body: Record<string, unknown>;
};

type QueuedFailure = {
  status: number;
  body: Record<string, unknown>;
};

/**
 * In-process Telegram Bot API test server.
 *
 * This is intentionally tiny and deterministic: it provides just enough of the
 * Bot API surface used by the Telegram bridge plugin while still exercising
 * real HTTP requests (no function-level mocks).
 */
export class FakeTelegramServer {
  private readonly bots = new Map<string, TelegramBot>();
  private readonly callsByMethod = new Map<TelegramMethod, MethodCall[]>();
  private readonly failures = new Map<string, QueuedFailure[]>();
  private readonly nextMessageIdByToken = new Map<string, number>();
  private readonly srv = createServer((req, res) => {
    void this.handleRequest(req, res);
  });

  get endpoint(): string {
    const addr = this.srv.address() as AddressInfo | null;
    if (!addr) throw new Error("FakeTelegramServer: not started yet");
    return `http://127.0.0.1:${addr.port}`;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.srv.once("error", reject);
      this.srv.listen(0, "127.0.0.1", () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if ("closeAllConnections" in this.srv) {
        (this.srv as { closeAllConnections(): void }).closeAllConnections();
      }
      this.srv.close((err) => (err ? reject(err) : resolve()));
    });
  }

  registerBot(token: string, bot: { id: string | number; username: string }): void {
    this.bots.set(token, { id: String(bot.id), username: bot.username });
  }

  queueFailure(
    token: string,
    method: TelegramMethod,
    failure: { status?: number; body: Record<string, unknown> },
  ): void {
    const key = `${token}:${method}`;
    const existing = this.failures.get(key) ?? [];
    existing.push({
      status: failure.status ?? 200,
      body: failure.body,
    });
    this.failures.set(key, existing);
  }

  calls(method: TelegramMethod): MethodCall[] {
    return [...(this.callsByMethod.get(method) ?? [])];
  }

  lastCall(method: TelegramMethod): MethodCall | null {
    const rows = this.calls(method);
    return rows.length > 0 ? rows[rows.length - 1] : null;
  }

  private pushCall(call: MethodCall): void {
    const arr = this.callsByMethod.get(call.method) ?? [];
    arr.push(call);
    this.callsByMethod.set(call.method, arr);
  }

  private popFailure(token: string, method: TelegramMethod): QueuedFailure | null {
    const key = `${token}:${method}`;
    const rows = this.failures.get(key);
    if (!rows || rows.length === 0) return null;
    const next = rows.shift() ?? null;
    if (rows.length === 0) this.failures.delete(key);
    return next;
  }

  private async readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw.length === 0) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const match = url.match(/^\/bot([^/]+)\/([^/?]+)/);
    if (!match) {
      this.writeJson(res, 404, { ok: false, description: "not found" });
      return;
    }

    const [, token, methodRaw] = match;
    const method = methodRaw as TelegramMethod;
    const body = await this.readJsonBody(req);

    if (!this.bots.has(token)) {
      this.writeJson(res, 401, { ok: false, description: "bad token" });
      return;
    }

    if (!["getMe", "setWebhook", "deleteWebhook", "sendMessage"].includes(method)) {
      this.writeJson(res, 404, { ok: false, description: `unknown method: ${method}` });
      return;
    }

    this.pushCall({ method, token, body });

    const forcedFailure = this.popFailure(token, method);
    if (forcedFailure) {
      this.writeJson(res, forcedFailure.status, forcedFailure.body);
      return;
    }

    const bot = this.bots.get(token);
    if (!bot) {
      this.writeJson(res, 401, { ok: false, description: "bad token" });
      return;
    }

    if (method === "getMe") {
      this.writeJson(res, 200, {
        ok: true,
        result: { id: Number(bot.id), username: bot.username },
      });
      return;
    }

    if (method === "setWebhook") {
      this.writeJson(res, 200, { ok: true, result: true });
      return;
    }

    if (method === "deleteWebhook") {
      this.writeJson(res, 200, { ok: true, result: true });
      return;
    }

    const current = this.nextMessageIdByToken.get(token) ?? 1000;
    this.nextMessageIdByToken.set(token, current + 1);
    this.writeJson(res, 200, {
      ok: true,
      result: { message_id: current },
    });
  }
}

