import { serve } from "@hono/node-server";
import { connect } from "./db.js";
import { createApp } from "./http.js";
import { MessageLayer } from "./service.js";

async function main(): Promise<void> {
  const adapter = process.env.STORAGE_ADAPTER === "sqlite" ? "sqlite" : "pglite";
  const path =
    process.env.STORAGE_PATH ??
    (adapter === "sqlite" ? ":memory:" : "memory://server");
  const db = await connect(path, { adapter });
  const service = new MessageLayer(db);
  const app = createApp(service);
  const port = Number(process.env.PORT ?? "3000");
  serve(
    {
      fetch: app.fetch,
      port,
    },
    () => {
      console.log(`message-layer listening on http://localhost:${port}`);
    },
  );
}

void main();
