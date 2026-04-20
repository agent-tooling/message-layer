import type { Principal } from "../../src/types.js";

export type Fetcher = (
  url: string | URL,
  init?: RequestInit & { headers?: Record<string, string> },
) => Promise<Response>;

export class HttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: Fetcher = globalThis.fetch,
  ) {}

  private merge(headers: Record<string, string> | undefined, principal: Principal | null): Record<string, string> {
    const out: Record<string, string> = { "content-type": "application/json", ...(headers ?? {}) };
    if (principal) out["x-principal"] = JSON.stringify(principal);
    return out;
  }

  async get<T>(path: string, principal: Principal | null, extraHeaders?: Record<string, string>): Promise<{ status: number; body: T }> {
    const res = await this.fetcher(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: this.merge(extraHeaders, principal),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  async post<T>(path: string, body: unknown, principal: Principal | null, extraHeaders?: Record<string, string>): Promise<{ status: number; body: T }> {
    const res = await this.fetcher(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.merge(extraHeaders, principal),
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  async del<T>(path: string, principal: Principal | null, extraHeaders?: Record<string, string>): Promise<{ status: number; body: T }> {
    const res = await this.fetcher(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: this.merge(extraHeaders, principal),
    });
    return { status: res.status, body: (await res.json()) as T };
  }
}

/**
 * Builds a Fetcher that dispatches through a Hono app's in-process `.fetch`
 * handler — avoids opening a TCP port while still exercising the real routing
 * and middleware chain.
 */
export function appFetcher(app: { fetch: (req: Request) => Promise<Response> | Response }): Fetcher {
  return async (url, init) => {
    const req = new Request(typeof url === "string" ? url : url.toString(), init as RequestInit);
    return app.fetch(req);
  };
}
