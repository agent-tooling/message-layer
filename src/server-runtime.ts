import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { loadServerConfig, type ServerConfig } from "./config.js";
import { connect, type SqlDatabase } from "./db.js";
import { InProcessEventBus, type EventBus } from "./event-bus.js";
import { createApp } from "./http.js";
import {
  applyPluginSchemas,
  applyPluginsToApp,
  notifyPluginsServerBound,
  resolvePlugins,
  type PluginLogger,
} from "./plugins.js";
import { MessageLayer, type MessageLayerService } from "./service.js";
import { createStorageAdapter, type StorageAdapter } from "./storage.js";
import { attachWebSocketServer, type WebSocketServerHandle } from "./ws.js";

export interface StartServerOptions {
  config?: ServerConfig;
  db?: SqlDatabase;
  /** Pre-built artifact blob storage. Overrides `config.artifacts`. */
  storage?: StorageAdapter;
  logger?: PluginLogger;
  env?: NodeJS.ProcessEnv;
  /** Bind to a random port when > 0 is not required. */
  port?: number;
}

export interface RunningServer {
  config: ServerConfig;
  service: MessageLayerService;
  bus: EventBus;
  db: SqlDatabase;
  port: number;
  address: string;
  httpServer: HttpServer;
  ws: WebSocketServerHandle | null;
  disposePlugins: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Boots a full message-layer server in-process: DB, service, HTTP app,
 * plugins, optional WebSocket transport. Returns a handle that shuts the
 * whole thing down cleanly.
 *
 * Designed for tests too: pass `port: 0` to get a random port, or pass a
 * pre-built `db` to share state across multiple servers.
 */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const env = options.env ?? process.env;
  const config: ServerConfig = options.config ?? loadServerConfig(env);
  const logger: PluginLogger = options.logger ?? ((msg) => console.log(msg));

  const db = options.db ?? (await connect(config.storage.path, config.storage.adapter));
  const bus = new InProcessEventBus((m) => logger(`[event-bus] ${m}`));
  const storage = options.storage ?? createStorageAdapter(config.artifacts);
  const service = new MessageLayer(db, { bus, storage, maxArtifactBytes: config.artifacts.maxBytes });

  const app = createApp(service);
  const plugins = resolvePlugins(config.plugins);
  await applyPluginSchemas(db, plugins, logger);
  const disposePlugins = await applyPluginsToApp(
    { app, db, service, bus, logger, env, config },
    plugins,
  );

  const port = options.port ?? config.port;

  const httpServer = await new Promise<HttpServer>((resolve) => {
    const s = serve({ fetch: app.fetch, port }, () => resolve(s as unknown as HttpServer));
  });

  // Notify all plugins that the HTTP server is now bound. The websocket plugin
  // uses this hook to call attachWebSocketServer.
  await notifyPluginsServerBound(plugins, httpServer);

  // Backward compat: if websocket: true in config AND no websocket plugin is
  // present, attach the WebSocket server directly.
  const hasWebSocketPlugin = plugins.some((p) => p.name === "websocket");
  let ws: WebSocketServerHandle | null = null;
  if (config.websocket && !hasWebSocketPlugin) {
    ws = attachWebSocketServer(httpServer, service, bus);
  }

  const address = httpServer.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;

  return {
    config,
    service,
    bus,
    db,
    port: resolvedPort,
    address: `http://127.0.0.1:${resolvedPort}`,
    httpServer,
    ws,
    disposePlugins,
    close: async () => {
      await ws?.close();
      await disposePlugins();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      if (!options.db) await db.close?.();
    },
  };
}
