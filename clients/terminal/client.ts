import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type Principal = {
  actorId: string;
  orgId: string;
  scopes: string[];
  provider: string;
};

type SessionState = {
  baseUrl: string;
  principal: Principal | null;
  orgId: string | null;
  actorId: string | null;
  channelId: string | null;
};

function printHelp(): void {
  console.log(`
Commands:
  help
  status
  set-base <url>
  set-principal <actorId> <orgId> [scope1,scope2]
  create-org <name>
  create-actor <orgId> <human|agent|app> <displayName>
  create-channel <name>
  grant <actorId> <resourceType> <resourceId|none> <capability>
  post <streamId> <channel|thread> <text>
  list <streamId> [afterSeq] [limit]
  subscribe <streamId> [fromSeq]
  create-thread <channelId> <parentMessageId>
  request-permission <action> <resourceType> <resourceId|none>
  resolve-permission <requestId> <approve:true|false> [notes]
  update-cursor <streamId> <lastSeenSeq> <lastAckSeq>
  register-client <endpoint>
  exit
`);
}

function splitArgs(command: string): string[] {
  return command.trim().split(/\s+/).filter((part) => part.length > 0);
}

async function apiCall(
  state: SessionState,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    requirePrincipal?: boolean;
  } = {},
): Promise<unknown> {
  if (options.requirePrincipal && !state.principal) {
    throw new Error("principal is required; set one with set-principal");
  }
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (state.principal) {
    headers["x-principal"] = JSON.stringify(state.principal);
  }
  const response = await fetch(`${state.baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    // keep raw text
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function toNullableResourceId(inputResourceId: string): string | null {
  return inputResourceId === "none" ? null : inputResourceId;
}

async function main(): Promise<void> {
  if (process.argv.includes("--smoke")) {
    console.log("terminal-client-smoke-ok");
    return;
  }

  const rl = readline.createInterface({ input, output });
  const state: SessionState = {
    baseUrl: process.env.MESSAGE_LAYER_BASE_URL ?? "http://127.0.0.1:3000",
    principal: null,
    orgId: null,
    actorId: null,
    channelId: null,
  };

  console.log("message-layer terminal client");
  printHelp();

  while (true) {
    const line = await rl.question("> ");
    const args = splitArgs(line);
    if (args.length === 0) {
      continue;
    }
    const [command, ...rest] = args;
    try {
      if (command === "exit" || command === "quit") {
        break;
      }

      if (command === "help") {
        printHelp();
        continue;
      }

      if (command === "status") {
        console.log(JSON.stringify(state, null, 2));
        continue;
      }

      if (command === "set-base") {
        const [url] = rest;
        if (!url) throw new Error("usage: set-base <url>");
        state.baseUrl = url;
        console.log(`base set to ${state.baseUrl}`);
        continue;
      }

      if (command === "set-principal") {
        const [actorId, orgId, scopesRaw = ""] = rest;
        if (!actorId || !orgId) throw new Error("usage: set-principal <actorId> <orgId> [scope1,scope2]");
        state.principal = {
          actorId,
          orgId,
          scopes: scopesRaw.length > 0 ? scopesRaw.split(",").map((s) => s.trim()).filter(Boolean) : [],
          provider: "terminal-ui",
        };
        state.actorId = actorId;
        state.orgId = orgId;
        console.log("principal updated");
        continue;
      }

      if (command === "create-org") {
        const name = rest.join(" ");
        if (!name) throw new Error("usage: create-org <name>");
        const payload = (await apiCall(state, "/v1/orgs", {
          method: "POST",
          body: { name },
        })) as { orgId: string };
        state.orgId = payload.orgId;
        console.log(payload);
        continue;
      }

      if (command === "create-actor") {
        const [orgId, actorType, ...nameParts] = rest;
        const displayName = nameParts.join(" ");
        if (!orgId || !actorType || !displayName) {
          throw new Error("usage: create-actor <orgId> <human|agent|app> <displayName>");
        }
        const payload = (await apiCall(state, "/v1/actors", {
          method: "POST",
          body: { orgId, actorType, displayName },
        })) as { actorId: string };
        state.actorId = payload.actorId;
        console.log(payload);
        continue;
      }

      if (command === "create-channel") {
        const name = rest.join(" ");
        if (!name) throw new Error("usage: create-channel <name>");
        const payload = (await apiCall(state, "/v1/channels", {
          method: "POST",
          body: { name },
          requirePrincipal: true,
        })) as { channelId: string };
        state.channelId = payload.channelId;
        console.log(payload);
        continue;
      }

      if (command === "grant") {
        const [actorId, resourceType, resourceId, capability] = rest;
        if (!actorId || !resourceType || !resourceId || !capability) {
          throw new Error("usage: grant <actorId> <resourceType> <resourceId|none> <capability>");
        }
        const payload = await apiCall(state, "/v1/grants", {
          method: "POST",
          body: {
            actorId,
            resourceType,
            resourceId: toNullableResourceId(resourceId),
            capability,
          },
          requirePrincipal: true,
        });
        console.log(payload);
        continue;
      }

      if (command === "post") {
        const [streamId, streamType, ...textParts] = rest;
        const text = textParts.join(" ");
        if (!streamId || !streamType || !text) {
          throw new Error("usage: post <streamId> <channel|thread> <text>");
        }
        const payload = await apiCall(state, "/v1/messages", {
          method: "POST",
          body: {
            streamId,
            streamType,
            parts: [{ type: "text", payload: { text } }],
            idempotencyKey: `terminal-${Date.now()}`,
          },
          requirePrincipal: true,
        });
        console.log(payload);
        continue;
      }

      if (command === "list") {
        const [streamId, afterSeq = "0", limit = "50"] = rest;
        if (!streamId) throw new Error("usage: list <streamId> [afterSeq] [limit]");
        const payload = await apiCall(
          state,
          `/v1/streams/${streamId}/messages?afterSeq=${Number(afterSeq)}&limit=${Number(limit)}`,
          { method: "GET", requirePrincipal: true },
        );
        console.log(JSON.stringify(payload, null, 2));
        continue;
      }

      if (command === "subscribe") {
        const [streamId, fromSeq = "0"] = rest;
        if (!streamId) throw new Error("usage: subscribe <streamId> [fromSeq]");
        const payload = await apiCall(
          state,
          `/v1/streams/${streamId}/subscribe?fromSeq=${Number(fromSeq)}`,
          { method: "GET", requirePrincipal: true },
        );
        console.log(JSON.stringify(payload, null, 2));
        continue;
      }

      if (command === "create-thread") {
        const [channelId, parentMessageId] = rest;
        if (!channelId || !parentMessageId) {
          throw new Error("usage: create-thread <channelId> <parentMessageId>");
        }
        const payload = await apiCall(state, "/v1/threads", {
          method: "POST",
          body: { channelId, parentMessageId },
          requirePrincipal: true,
        });
        console.log(payload);
        continue;
      }

      if (command === "request-permission") {
        const [action, resourceType, resourceId] = rest;
        if (!action || !resourceType || !resourceId) {
          throw new Error("usage: request-permission <action> <resourceType> <resourceId|none>");
        }
        const payload = await apiCall(state, "/v1/permission-requests", {
          method: "POST",
          body: { action, resourceType, resourceId: toNullableResourceId(resourceId) },
          requirePrincipal: true,
        });
        console.log(payload);
        continue;
      }

      if (command === "resolve-permission") {
        const [requestId, approveRaw, ...notesParts] = rest;
        if (!requestId || !approveRaw) {
          throw new Error("usage: resolve-permission <requestId> <approve:true|false> [notes]");
        }
        const approve = approveRaw === "true";
        const notes = notesParts.join(" ");
        const payload = await apiCall(state, `/v1/permission-requests/${requestId}/resolve`, {
          method: "POST",
          body: { approve, notes },
          requirePrincipal: true,
        });
        console.log(payload);
        continue;
      }

      if (command === "update-cursor") {
        const [streamId, lastSeenSeq, lastAckSeq] = rest;
        if (!streamId || !lastSeenSeq || !lastAckSeq) {
          throw new Error("usage: update-cursor <streamId> <lastSeenSeq> <lastAckSeq>");
        }
        const payload = await apiCall(state, "/v1/cursors", {
          method: "POST",
          body: { streamId, lastSeenSeq: Number(lastSeenSeq), lastAckSeq: Number(lastAckSeq) },
          requirePrincipal: true,
        });
        console.log(payload);
        continue;
      }

      if (command === "register-client") {
        const endpoint = rest.join(" ");
        if (!endpoint) throw new Error("usage: register-client <endpoint>");
        const payload = await apiCall(state, "/v1/clients", {
          method: "POST",
          body: { endpoint, metadata: { source: "terminal-ui" } },
          requirePrincipal: true,
        });
        console.log(payload);
        continue;
      }

      console.log(`unknown command: ${command}`);
      printHelp();
    } catch (error) {
      if (error instanceof Error) {
        console.error(`error: ${error.message}`);
      } else {
        console.error("error:", error);
      }
    }
  }

  rl.close();
}

void main();
