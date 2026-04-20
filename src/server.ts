import { startServer } from "./server-runtime.js";

async function main(): Promise<void> {
  const server = await startServer();
  console.log(
    `message-layer listening on ${server.address} adapter=${server.config.storage.adapter} ws=${server.ws ? "on" : "off"}`,
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
