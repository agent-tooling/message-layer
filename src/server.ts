import { serve } from "@hono/node-server";
import { createHttpApp } from "./http.js";

const port = Number(process.env.PORT ?? "3000");
const app = createHttpApp();

serve(
  {
    fetch: app.fetch,
    port,
  },
  () => {
    console.log(`message-layer listening on http://localhost:${port}`);
  },
);
