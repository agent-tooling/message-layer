import { serve } from "@hono/node-server";
import { connect } from "./db.js";
import { loadServerConfig } from "./config.js";
import { createApp } from "./http.js";
import { MessageLayer } from "./service.js";
import { createPlugins, runPluginSetup } from "./plugins.js";

async function main(): Promise<void> {
  const config = loadServerConfig(process.env);
  const db = await connect(config.storage.path, config.storage.adapter);
  const service = new MessageLayer(db);
  const app = createApp(service);
  const plugins = createPlugins(config.plugins);
  await runPluginSetup(plugins, {
    app,
    service,
    logger: (message: string) => {
      console.log(message);
    },
    config,
  });
  for (const plugin of plugins) {
    plugin.registerRoutes?.({
      app,
      service,
      logger: (message: string) => {
        console.log(message);
      },
      config,
    });
  }

  const port = config.port;
  serve(
    {
      fetch: app.fetch,
      port,
    },
    () => {
      console.log(`message-layer listening on http://localhost:${port} adapter=${config.storage.adapter}`);
    },
  );
}

void main();
