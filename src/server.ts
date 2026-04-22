import { startServer } from "./server-runtime.js";

async function main(): Promise<void> {
  const server = await startServer();
  const wsEnabled = server.config.plugins.some((p) =>
    typeof p === "string" ? p === "websocket" : p.name === "websocket",
  );
  console.log(
    `message-layer listening on ${server.address} adapter=${server.config.storage.adapter} ws=${wsEnabled ? "on" : "off"}`,
  );
  const shutdown = async (): Promise<void> => {
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

void main();
