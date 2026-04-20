/**
 * message-layer terminal client
 *
 * Two modes:
 *   1. Agent mode (default)  — Pi coding agent powered by message-layer as kernel.
 *      Supports model selection, tool approval, prompt/steer/follow-up.
 *   2. Raw mode (--raw)      — Low-level REPL over the HTTP API for debugging.
 */

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { AgentKernel } from "../../src/agent-kernel/index.js";
import type { KernelConfig } from "../../src/agent-kernel/index.js";

// ── Types ──────────────────────────────────────────────────────────────────────

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

// ── Colours ───────────────────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
};

function dim(s: string) { return `${c.dim}${s}${c.reset}`; }
function bold(s: string) { return `${c.bold}${s}${c.reset}`; }
function cyan(s: string) { return `${c.cyan}${s}${c.reset}`; }
function green(s: string) { return `${c.green}${s}${c.reset}`; }
function yellow(s: string) { return `${c.yellow}${s}${c.reset}`; }
function red(s: string) { return `${c.red}${s}${c.reset}`; }
function magenta(s: string) { return `${c.magenta}${s}${c.reset}`; }

// ── Helpers ───────────────────────────────────────────────────────────────────

function splitArgs(command: string): string[] {
  return command.trim().split(/\s+/).filter((p) => p.length > 0);
}

function toNullableResourceId(s: string): string | null {
  return s === "none" ? null : s;
}

async function apiCall(
  state: SessionState,
  path: string,
  options: { method?: string; body?: unknown; requirePrincipal?: boolean } = {},
): Promise<unknown> {
  if (options.requirePrincipal && !state.principal) {
    throw new Error("principal required; set one with set-principal");
  }
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (state.principal) {
    headers["x-principal"] = JSON.stringify(state.principal);
  }
  const res = await fetch(`${state.baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let payload: unknown = text;
  try { payload = text.length > 0 ? JSON.parse(text) : {}; } catch { /* raw text */ }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(payload)}`);
  return payload;
}

// ── Agent mode help ──────────────────────────────────────────────────────────

function printAgentHelp(): void {
  console.log(`
${bold("message-layer  ×  pi coding agent")}

${cyan("Setup")}
  init                       Auto-create org + agent actor + channel and start kernel
  setup <orgId> <actorId> <adminActorId> <channelId>
                             Use existing ids and start kernel

${cyan("Prompting")}
  <text>                     Send a prompt to the agent (default action)
  steer <text>               Steer while agent is running
  follow <text>              Queue follow-up for after the current turn

${cyan("Model")}
  model list                 List available models (those with API keys set)
  model set <provider/id>    Switch to a specific model (e.g. anthropic/claude-opus-4-5)
  model cycle                Cycle to the next model
  model status               Show current model

${cyan("Permissions")}
  pending                    List pending tool approval requests
  approve <requestId>        Approve a pending tool call
  deny <requestId> [reason]  Deny a pending tool call

${cyan("Session")}
  status                     Show current session / kernel state
  abort                      Abort the running agent turn
  messages [limit]           Fetch last N messages from the stream

${cyan("Advanced / Raw API")}
  --raw                      Switch to raw REPL for low-level API access
  exit                       Quit
`);
}

function printRawHelp(): void {
  console.log(`
${bold("message-layer raw REPL")}

  set-base <url>
  set-principal <actorId> <orgId> [scope1,scope2]
  create-org <name>
  create-actor <orgId> <human|agent|app> <displayName>
  create-channel <name>
  grant <actorId> <resourceType> <resourceId|none> <capability>
  revoke <grantId>
  post <streamId> <channel|thread> <text>
  list <streamId> [afterSeq] [limit]
  subscribe <streamId> [fromSeq]
  create-thread <channelId> <parentMessageId>
  request-permission <action> <resourceType> <resourceId|none>
  resolve-permission <requestId> <approve:true|false> [notes]
  list-permissions [actorId]
  update-cursor <streamId> <lastSeenSeq> <lastAckSeq>
  register-client <endpoint>
  back                       Return to agent REPL
  exit
`);
}

// ── Smoke mode ────────────────────────────────────────────────────────────────

if (process.argv.includes("--smoke")) {
  console.log("terminal-client-smoke-ok");
  process.exit(0);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  const baseUrl = process.env.MESSAGE_LAYER_BASE_URL ?? "http://127.0.0.1:3000";

  let kernel: AgentKernel | null = null;
  let agentOrgId: string | null = null;
  let agentActorId: string | null = null;
  let adminActorId: string | null = null;
  let channelId: string | null = null;
  let mode: "agent" | "raw" = "agent";

  // Raw mode session state
  const rawState: SessionState = {
    baseUrl,
    principal: null,
    orgId: null,
    actorId: null,
    channelId: null,
  };

  console.log(bold("\nmessage-layer terminal  ×  pi coding agent\n"));
  printAgentHelp();

  async function startKernel(cfg: KernelConfig): Promise<void> {
    if (kernel) {
      kernel.dispose();
    }
    kernel = new AgentKernel(cfg);
    console.log(yellow("Initialising Pi session…"));

    let lineBuffer = "";
    let streaming = false;

    await kernel.init();

    kernel.onOutput((delta) => {
      if (!streaming) {
        process.stdout.write(`\n${green("agent")} `);
        streaming = true;
      }
      lineBuffer += delta;
      process.stdout.write(delta);
      if (delta.includes("\n")) {
        lineBuffer = "";
      }
    });

    // Also subscribe for approval prompts via a polling loop
    // (approvals arrive as pending entries on the kernel state)
    const checkApprovals = setInterval(() => {
      const pending = kernel?.state.pendingApprovals ?? [];
      for (const a of pending) {
        if (!(a as unknown as { notified?: boolean }).notified) {
          (a as unknown as { notified?: boolean }).notified = true;
          console.log(
            `\n${yellow("⚠")} Tool approval required: ${bold(a.toolName)} (${dim(a.requestId)})\n` +
            `  args: ${dim(JSON.stringify(a.args))}\n` +
            `  ${cyan("approve " + a.requestId)} or ${red("deny " + a.requestId)}`,
          );
        }
      }
    }, 500);

    console.log(green("✓ Pi session ready.") + dim("  Type a prompt or 'help' for commands.\n"));

    const modelModels = await kernel.availableModels().catch(() => []);
    if (modelModels.length > 0) {
      const current = kernel.state.model;
      const name = current ? `${current.provider}/${current.id}` : modelModels[0] ? `${modelModels[0].provider}/${modelModels[0].id}` : "unknown";
      console.log(`${cyan("model")} ${name}  ${dim("(model list/set/cycle to change)")}`);
    }
    console.log();

    // Return cleanup for when kernel is disposed
    return new Promise<void>((resolve) => {
      const unsub = kernel!.onOutput(() => {});
      unsub(); // just to confirm onOutput works; real unsub handled by dispose
      // clearInterval on dispose
      const origDispose = kernel!.dispose.bind(kernel!);
      (kernel as unknown as { dispose: () => void }).dispose = () => {
        clearInterval(checkApprovals);
        origDispose();
        resolve();
      };
    }).catch(() => {});
  }

  // ── Auto-init helper ────────────────────────────────────────────────────────

  async function autoInit(): Promise<void> {
    console.log(yellow("Creating org, actors, and channel…"));
    try {
      const org = (await apiCall(rawState, "/v1/orgs", { method: "POST", body: { name: "default" } })) as { orgId: string };
      agentOrgId = org.orgId;

      // Create a human actor (admin)
      const human = (await apiCall(rawState, "/v1/actors", {
        method: "POST",
        body: { orgId: agentOrgId, actorType: "human", displayName: "user" },
      })) as { actorId: string };
      adminActorId = human.actorId;

      // Create agent actor
      const agent = (await apiCall(rawState, "/v1/actors", {
        method: "POST",
        body: { orgId: agentOrgId, actorType: "agent", displayName: "pi" },
      })) as { actorId: string };
      agentActorId = agent.actorId;

      const adminPrincipal: Principal = {
        actorId: adminActorId,
        orgId: agentOrgId,
        scopes: ["channel:create", "grant:create", "message:append"],
        provider: "terminal-ui",
      };
      rawState.principal = adminPrincipal;
      rawState.orgId = agentOrgId;
      rawState.actorId = adminActorId;

      // Create channel
      const chan = (await apiCall(rawState, "/v1/channels", {
        method: "POST",
        body: { name: "main" },
        requirePrincipal: true,
      })) as { channelId: string };
      channelId = chan.channelId;
      rawState.channelId = channelId;

      // Grant agent actor message:append on the channel
      await apiCall(rawState, "/v1/grants", {
        method: "POST",
        body: { actorId: agentActorId, resourceType: "channel", resourceId: channelId, capability: "message:append" },
        requirePrincipal: true,
      });

      console.log(green(`✓ org=${agentOrgId}  agent=${agentActorId}  admin=${adminActorId}  channel=${channelId}`));
      await doStartKernel();
    } catch (err) {
      console.error(red(`auto-init failed: ${String(err)}`));
    }
  }

  async function doStartKernel(): Promise<void> {
    if (!agentOrgId || !agentActorId || !adminActorId || !channelId) {
      console.error(red("Missing ids. Run 'init' or 'setup' first."));
      return;
    }
    const cfg: KernelConfig = {
      baseUrl,
      agentPrincipal: { actorId: agentActorId, orgId: agentOrgId, scopes: [], provider: "pi" },
      adminPrincipal: { actorId: adminActorId, orgId: agentOrgId, scopes: ["grant:create"], provider: "terminal-ui" },
      streamId: channelId,
      streamType: "channel",
    };
    void startKernel(cfg);
  }

  // ── Main REPL ───────────────────────────────────────────────────────────────

  while (true) {
    const prompt = mode === "agent"
      ? (kernel ? `${cyan("pi")}> ` : `${dim("pi")}> `)
      : `${magenta("raw")}> `;

    const line = await rl.question(prompt).catch(() => "exit");
    const args = splitArgs(line);
    if (args.length === 0) continue;
    const [cmd, ...rest] = args;

    try {
      // ── Universal commands ────────────────────────────────────────────────
      if (cmd === "exit" || cmd === "quit") {
        kernel?.dispose();
        break;
      }

      if (cmd === "help") {
        mode === "agent" ? printAgentHelp() : printRawHelp();
        continue;
      }

      // ── Mode switch ───────────────────────────────────────────────────────
      if (cmd === "--raw" || cmd === "raw") {
        mode = "raw";
        console.log(magenta("Switched to raw REPL. Type 'back' to return."));
        printRawHelp();
        continue;
      }
      if (cmd === "back" && mode === "raw") {
        mode = "agent";
        console.log(cyan("Back to agent REPL."));
        continue;
      }

      // ── Agent mode commands ──────────────────────────────────────────────
      if (mode === "agent") {
        if (cmd === "init") {
          await autoInit();
          continue;
        }

        if (cmd === "setup") {
          const [oId, aId, adminId, chId] = rest;
          if (!oId || !aId || !adminId || !chId) {
            throw new Error("usage: setup <orgId> <agentActorId> <adminActorId> <channelId>");
          }
          agentOrgId = oId;
          agentActorId = aId;
          adminActorId = adminId;
          channelId = chId;
          rawState.orgId = oId;
          rawState.actorId = adminId;
          rawState.principal = { actorId: adminId, orgId: oId, scopes: ["channel:create", "grant:create", "message:append"], provider: "terminal-ui" };
          await doStartKernel();
          continue;
        }

        if (cmd === "status") {
          if (!kernel) {
            console.log(dim("No kernel running. Use 'init' or 'setup'."));
          } else {
            const s = kernel.state;
            console.log(`status: ${s.status === "idle" ? green(s.status) : s.status === "running" ? yellow(s.status) : s.status === "waiting_approval" ? red(s.status) : dim(s.status)}`);
            console.log(`model:  ${s.model ? `${s.model.provider}/${s.model.id}` : dim("none")}`);
            console.log(`session: ${s.sessionId ?? dim("none")}`);
            console.log(`pending approvals: ${s.pendingApprovals.length}`);
            console.log(`org=${agentOrgId}  agent=${agentActorId}  channel=${channelId}`);
          }
          continue;
        }

        if (cmd === "abort") {
          if (!kernel) throw new Error("no kernel running");
          await kernel.abort();
          console.log(yellow("aborted"));
          continue;
        }

        if (cmd === "steer") {
          if (!kernel) throw new Error("no kernel running; use 'init' first");
          const text = rest.join(" ");
          if (!text) throw new Error("usage: steer <text>");
          await kernel.steer(text);
          continue;
        }

        if (cmd === "follow") {
          if (!kernel) throw new Error("no kernel running; use 'init' first");
          const text = rest.join(" ");
          if (!text) throw new Error("usage: follow <text>");
          await kernel.followUp(text);
          continue;
        }

        if (cmd === "model") {
          if (!kernel) throw new Error("no kernel running; use 'init' first");
          const sub = rest[0];
          if (!sub || sub === "list") {
            const models = await kernel.availableModels();
            if (models.length === 0) {
              console.log(yellow("No models with API keys configured. Set provider API keys in ~/.pi/agent/auth.json"));
            } else {
              const current = kernel.state.model;
              for (const m of models) {
                const isCurrent = current && m.provider === current.provider && m.id === current.id;
                console.log(`${isCurrent ? green("▶") : " "} ${m.provider}/${m.id}  ${dim(m.name)}`);
              }
            }
          } else if (sub === "set") {
            const pattern = rest.slice(1).join(" ");
            if (!pattern) throw new Error("usage: model set <provider/id>");
            const ok = await kernel.setModel(pattern);
            console.log(ok ? green(`Model set to ${pattern}`) : red(`Model '${pattern}' not found or has no API key`));
          } else if (sub === "cycle") {
            const name = await kernel.cycleModel();
            console.log(name ? green(`Cycled to ${name}`) : yellow("No other model available"));
          } else if (sub === "status") {
            const m = kernel.state.model;
            console.log(m ? `${m.provider}/${m.id}` : dim("none"));
          } else {
            throw new Error("usage: model list|set|cycle|status");
          }
          continue;
        }

        if (cmd === "pending") {
          if (!kernel) throw new Error("no kernel running");
          const pending = kernel.state.pendingApprovals;
          if (pending.length === 0) {
            console.log(dim("No pending approvals"));
          } else {
            for (const a of pending) {
              console.log(`${yellow("•")} ${bold(a.toolName)}  id=${dim(a.requestId)}\n  args: ${dim(JSON.stringify(a.args))}`);
            }
          }
          continue;
        }

        if (cmd === "approve") {
          if (!kernel) throw new Error("no kernel running");
          const [requestId] = rest;
          if (!requestId) throw new Error("usage: approve <requestId>");
          await kernel.approve(requestId, rest.slice(1).join(" "));
          console.log(green(`✓ Approved ${requestId}`));
          continue;
        }

        if (cmd === "deny") {
          if (!kernel) throw new Error("no kernel running");
          const [requestId, ...notesParts] = rest;
          if (!requestId) throw new Error("usage: deny <requestId> [reason]");
          await kernel.deny(requestId, notesParts.join(" ") || "denied by user");
          console.log(red(`✗ Denied ${requestId}`));
          continue;
        }

        if (cmd === "messages") {
          if (!rawState.principal || !channelId) {
            throw new Error("no channel active; run 'init' or 'setup' first");
          }
          const limit = Number(rest[0] ?? "20");
          const payload = (await apiCall(rawState, `/v1/streams/${channelId}/messages?afterSeq=0&limit=${limit}`, { requirePrincipal: true })) as {
            messages: Array<{ id: string; actorId: string; streamSeq: number; parts: Array<{ type: string; payload: Record<string, unknown> }> }>;
          };
          for (const msg of payload.messages) {
            const who = msg.actorId === agentActorId ? green("agent") : cyan("human");
            for (const p of msg.parts) {
              if (p.type === "text") {
                console.log(`${who} [${msg.streamSeq}] ${p.payload.text as string}`);
              } else if (p.type === "tool_call") {
                console.log(`${yellow("tool_call")} [${msg.streamSeq}] ${p.payload.toolName as string}(${dim(JSON.stringify(p.payload.args))})`);
              } else if (p.type === "tool_result") {
                const isErr = p.payload.isError;
                console.log(`${isErr ? red("tool_result") : dim("tool_result")} ${p.payload.toolName as string}: ${String(p.payload.content).slice(0, 120)}`);
              } else if (p.type === "approval_request") {
                console.log(`${yellow("approval_request")} tool=${p.payload.toolName as string} id=${p.payload.requestId as string}`);
              } else if (p.type === "approval_response") {
                const approved = p.payload.approved;
                console.log(`${approved ? green("approved") : red("denied")} requestId=${p.payload.requestId as string}`);
              } else {
                console.log(`${dim(p.type)} ${JSON.stringify(p.payload)}`);
              }
            }
          }
          continue;
        }

        // Default: treat as a prompt
        if (!kernel) {
          console.log(yellow("No kernel running. Type 'init' to set up or 'help' for commands."));
          continue;
        }
        const promptText = line.trim();
        if (!promptText) continue;
        // prompt() is non-blocking here; output streams via onOutput
        kernel.prompt(promptText).catch((err) => console.error(red(`prompt error: ${String(err)}`)));
        continue;
      }

      // ── Raw mode commands ─────────────────────────────────────────────────
      if (mode === "raw") {
        if (cmd === "status") {
          console.log(JSON.stringify({ ...rawState, principal: rawState.principal ? { ...rawState.principal, scopes: rawState.principal.scopes } : null }, null, 2));
          continue;
        }

        if (cmd === "set-base") {
          const [url] = rest;
          if (!url) throw new Error("usage: set-base <url>");
          rawState.baseUrl = url;
          console.log(`base → ${rawState.baseUrl}`);
          continue;
        }

        if (cmd === "set-principal") {
          const [actorId, orgId, scopesRaw = ""] = rest;
          if (!actorId || !orgId) throw new Error("usage: set-principal <actorId> <orgId> [scope1,scope2]");
          rawState.principal = {
            actorId,
            orgId,
            scopes: scopesRaw.length > 0 ? scopesRaw.split(",").map((s) => s.trim()).filter(Boolean) : [],
            provider: "terminal-ui",
          };
          rawState.actorId = actorId;
          rawState.orgId = orgId;
          console.log("principal updated");
          continue;
        }

        if (cmd === "create-org") {
          const name = rest.join(" ");
          if (!name) throw new Error("usage: create-org <name>");
          const payload = (await apiCall(rawState, "/v1/orgs", { method: "POST", body: { name } })) as { orgId: string };
          rawState.orgId = payload.orgId;
          console.log(payload);
          continue;
        }

        if (cmd === "create-actor") {
          const [orgId, actorType, ...nameParts] = rest;
          const displayName = nameParts.join(" ");
          if (!orgId || !actorType || !displayName) throw new Error("usage: create-actor <orgId> <human|agent|app> <displayName>");
          const payload = (await apiCall(rawState, "/v1/actors", { method: "POST", body: { orgId, actorType, displayName } })) as { actorId: string };
          rawState.actorId = payload.actorId;
          console.log(payload);
          continue;
        }

        if (cmd === "create-channel") {
          const name = rest.join(" ");
          if (!name) throw new Error("usage: create-channel <name>");
          const payload = (await apiCall(rawState, "/v1/channels", { method: "POST", body: { name }, requirePrincipal: true })) as { channelId: string };
          rawState.channelId = payload.channelId;
          console.log(payload);
          continue;
        }

        if (cmd === "grant") {
          const [actorId, resourceType, resourceId, capability] = rest;
          if (!actorId || !resourceType || !resourceId || !capability) throw new Error("usage: grant <actorId> <resourceType> <resourceId|none> <capability>");
          console.log(await apiCall(rawState, "/v1/grants", { method: "POST", body: { actorId, resourceType, resourceId: toNullableResourceId(resourceId), capability }, requirePrincipal: true }));
          continue;
        }

        if (cmd === "revoke") {
          const [grantId] = rest;
          if (!grantId) throw new Error("usage: revoke <grantId>");
          console.log(await apiCall(rawState, `/v1/grants/${grantId}/revoke`, { method: "POST", requirePrincipal: true }));
          continue;
        }

        if (cmd === "post") {
          const [streamId, streamType, ...textParts] = rest;
          const text = textParts.join(" ");
          if (!streamId || !streamType || !text) throw new Error("usage: post <streamId> <channel|thread> <text>");
          console.log(await apiCall(rawState, "/v1/messages", {
            method: "POST",
            body: { streamId, streamType, parts: [{ type: "text", payload: { text } }], idempotencyKey: `terminal-${Date.now()}` },
            requirePrincipal: true,
          }));
          continue;
        }

        if (cmd === "list") {
          const [streamId, afterSeq = "0", limit = "50"] = rest;
          if (!streamId) throw new Error("usage: list <streamId> [afterSeq] [limit]");
          console.log(JSON.stringify(await apiCall(rawState, `/v1/streams/${streamId}/messages?afterSeq=${afterSeq}&limit=${limit}`, { requirePrincipal: true }), null, 2));
          continue;
        }

        if (cmd === "subscribe") {
          const [streamId, fromSeq = "0"] = rest;
          if (!streamId) throw new Error("usage: subscribe <streamId> [fromSeq]");
          console.log(JSON.stringify(await apiCall(rawState, `/v1/streams/${streamId}/subscribe?fromSeq=${fromSeq}`, { requirePrincipal: true }), null, 2));
          continue;
        }

        if (cmd === "create-thread") {
          const [chId, parentMessageId] = rest;
          if (!chId || !parentMessageId) throw new Error("usage: create-thread <channelId> <parentMessageId>");
          console.log(await apiCall(rawState, "/v1/threads", { method: "POST", body: { channelId: chId, parentMessageId }, requirePrincipal: true }));
          continue;
        }

        if (cmd === "request-permission") {
          const [action, resourceType, resourceId] = rest;
          if (!action || !resourceType || !resourceId) throw new Error("usage: request-permission <action> <resourceType> <resourceId|none>");
          console.log(await apiCall(rawState, "/v1/permission-requests", { method: "POST", body: { action, resourceType, resourceId: toNullableResourceId(resourceId) }, requirePrincipal: true }));
          continue;
        }

        if (cmd === "list-permissions") {
          const actorId = rest[0];
          const qs = actorId ? `?actorId=${actorId}` : "";
          console.log(JSON.stringify(await apiCall(rawState, `/v1/permission-requests${qs}`, { requirePrincipal: true }), null, 2));
          continue;
        }

        if (cmd === "resolve-permission") {
          const [requestId, approveStr, ...notesParts] = rest;
          if (!requestId || !approveStr) throw new Error("usage: resolve-permission <requestId> <approve:true|false> [notes]");
          const approve = approveStr === "true";
          const notes = notesParts.join(" ");
          console.log(await apiCall(rawState, `/v1/permission-requests/${requestId}/resolve`, { method: "POST", body: { approve, notes }, requirePrincipal: true }));
          continue;
        }

        if (cmd === "update-cursor") {
          const [streamId, lastSeenSeq, lastAckSeq] = rest;
          if (!streamId || !lastSeenSeq || !lastAckSeq) throw new Error("usage: update-cursor <streamId> <lastSeenSeq> <lastAckSeq>");
          console.log(await apiCall(rawState, "/v1/cursors", { method: "POST", body: { streamId, lastSeenSeq: Number(lastSeenSeq), lastAckSeq: Number(lastAckSeq) }, requirePrincipal: true }));
          continue;
        }

        if (cmd === "register-client") {
          const [endpoint] = rest;
          if (!endpoint) throw new Error("usage: register-client <endpoint>");
          console.log(await apiCall(rawState, "/v1/clients", { method: "POST", body: { endpoint }, requirePrincipal: true }));
          continue;
        }

        console.log(red(`Unknown command: ${cmd}. Type 'help' for commands.`));
        continue;
      }
    } catch (err) {
      console.error(red(`Error: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  rl.close();
  kernel?.dispose();
}

void main();
