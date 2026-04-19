import { Hono } from "hono";
import { MessageLayerService } from "./service.js";
import type { Principal } from "./types.js";

function parsePrincipal(headerValue: string | undefined): Principal | null {
  if (!headerValue) {
    return null;
  }
  try {
    const parsed = JSON.parse(headerValue) as Principal;
    if (!parsed.actorId || !parsed.orgId || !Array.isArray(parsed.scopes) || !parsed.provider) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function createApp(service: MessageLayerService): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/v1/orgs", async (c) => {
    const body = await c.req.json<{ name: string }>();
    const orgId = await service.createOrg(body.name);
    return c.json({ orgId });
  });

  app.post("/v1/actors", async (c) => {
    const body = await c.req.json<{ orgId: string; actorType: "human" | "agent" | "app"; displayName: string }>();
    const actorId = await service.createActor(body.orgId, body.actorType, body.displayName);
    return c.json({ actorId });
  });

  app.post("/v1/channels", async (c) => {
    const principal = parsePrincipal(c.req.header("x-principal"));
    if (!principal) {
      return c.json({ error: "missing or invalid principal" }, 401);
    }
    const body = await c.req.json<{ name: string; visibility?: "private" | "public" }>();
    const channelId = await service.createChannel(principal, body.name, body.visibility ?? "private");
    return c.json({ channelId });
  });

  return app;
}
