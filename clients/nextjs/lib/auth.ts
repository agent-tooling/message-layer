import { join } from "node:path";
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { agentAuth } from "@better-auth/agent-auth";
import { env } from "@/lib/env";
import {
  appendMessage,
  ensureUserPrincipal,
  getDefaultChannelId,
  listChannels,
  listMemory,
  listMessages,
  listStreamArtifacts,
  promoteMemory,
  registerArtifact,
  searchEntities,
  searchMemory,
} from "@/lib/message-layer";
import { createInvite, TEAM_CLIENT_DATA_DIR } from "@/lib/app-db";

const authDb = new Database(join(TEAM_CLIENT_DATA_DIR, "better-auth.db"));

// Local dev + smoke tests reach the app on both `localhost:3001` and
// `127.0.0.1:3001`. Better Auth defaults to rejecting any origin that does
// not match `baseURL` exactly (403 "Invalid origin"). Adding both here
// preserves the CSRF check while accommodating the documented workflow.
const trustedOrigins = [
  env.BETTER_AUTH_URL,
  env.NEXT_PUBLIC_APP_URL,
  "http://localhost:3001",
  "http://127.0.0.1:3001",
];

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: Array.from(new Set(trustedOrigins)),
  database: authDb,
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    organization({
      async sendInvitationEmail(data) {
        const url = new URL(`${env.NEXT_PUBLIC_APP_URL}/invite/accept`);
        url.searchParams.set("invitationId", data.id);
        createInvite({
          token: data.id,
          email: data.email,
          role: "member",
          inviterUserId: data.inviter.user.id,
          createdAt: new Date().toISOString(),
        });
        console.log(`invite created for ${data.email}: ${url.toString()}`);
      },
    }),
    agentAuth({
      providerName: "message-layer-team-client",
      providerDescription: "Agent onboarding for the message-layer team client",
      modes: ["delegated", "autonomous"],
      capabilities: [
        {
          name: "channels.read",
          description: "List channels available to the user",
          input: { type: "object", properties: {} },
        },
        {
          name: "messages.read",
          description: "Read channel messages",
          input: {
            type: "object",
            required: ["channelId"],
            properties: {
              channelId: { type: "string" },
              afterSeq: { type: "number" },
            },
          },
        },
        {
          name: "messages.append",
          description: "Append a text message into a channel",
          input: {
            type: "object",
            required: ["channelId", "text"],
            properties: {
              channelId: { type: "string" },
              text: { type: "string" },
            },
          },
        },
        {
          name: "artifacts.list",
          description: "List artifacts attached to a channel or thread",
          input: {
            type: "object",
            required: ["streamId"],
            properties: { streamId: { type: "string" } },
          },
        },
        {
          name: "artifacts.upload",
          description:
            "Upload an artifact (binary blob) to a channel or thread",
          input: {
            type: "object",
            required: ["streamId", "filename", "contentType", "contentBase64"],
            properties: {
              streamId: { type: "string" },
              streamType: { type: "string", enum: ["channel", "thread"] },
              filename: { type: "string" },
              contentType: { type: "string" },
              contentBase64: { type: "string" },
              sha256: { type: "string" },
            },
          },
        },
        {
          name: "memory.list",
          description: "List derived memory units for a stream",
          input: {
            type: "object",
            required: ["streamId"],
            properties: { streamId: { type: "string" } },
          },
        },
        {
          name: "memory.search",
          description:
            "Lexical search across memory units the agent's user can read",
          input: {
            type: "object",
            required: ["query"],
            properties: {
              query: { type: "string" },
              streamId: { type: "string" },
              limit: { type: "number" },
            },
          },
        },
        {
          name: "memory.promote",
          description:
            "Promote a memory unit org-wide (requires memory:promote grant)",
          input: {
            type: "object",
            required: ["memoryId"],
            properties: {
              memoryId: { type: "string" },
              summary: { type: "string" },
            },
          },
        },
        {
          name: "search.query",
          description:
            "Cross-entity lexical search across actors, channels, threads, messages, and memory",
          input: {
            type: "object",
            required: ["query"],
            properties: {
              query: { type: "string" },
              entityTypes: {
                type: "array",
                items: {
                  type: "string",
                  enum: ["actor", "channel", "thread", "message", "memory"],
                },
              },
              streamId: { type: "string" },
              actorType: { type: "string", enum: ["human", "agent", "app"] },
              limit: { type: "number" },
            },
          },
        },
      ],
      onExecute: async ({ capability, arguments: args, agentSession }) => {
        const principal = await ensureUserPrincipal({
          id: agentSession.user.id,
          email: agentSession.user.email,
          name: agentSession.user.name ?? null,
        });

        if (capability === "channels.read") {
          return { channels: await listChannels(principal) };
        }
        if (capability === "messages.read") {
          const channelId = String(args?.channelId ?? "");
          const afterSeq = Number(args?.afterSeq ?? 0);
          return {
            messages: await listMessages(principal, channelId, afterSeq),
          };
        }
        if (capability === "messages.append") {
          const channelId = String(args?.channelId ?? "");
          const text = String(args?.text ?? "");
          await appendMessage(principal, {
            streamId: channelId,
            streamType: "channel",
            parts: [{ type: "text", payload: { text } }],
          });
          return { ok: true };
        }
        if (capability === "artifacts.list") {
          const streamId = String(args?.streamId ?? "");
          return { artifacts: await listStreamArtifacts(principal, streamId) };
        }
        if (capability === "artifacts.upload") {
          const streamId = String(args?.streamId ?? "");
          const streamType =
            args?.streamType === "thread" ? "thread" : "channel";
          const filename = String(args?.filename ?? "");
          const contentType = String(args?.contentType ?? "");
          const contentBase64 = String(args?.contentBase64 ?? "");
          const sha256 =
            typeof args?.sha256 === "string" ? args.sha256 : undefined;
          const content = Buffer.from(contentBase64, "base64");
          const artifact = await registerArtifact(principal, {
            streamId,
            streamType,
            filename,
            contentType,
            content,
            sha256,
          });
          return { artifact };
        }
        if (capability === "memory.list") {
          const streamId = String(args?.streamId ?? "");
          return { units: await listMemory(principal, streamId) };
        }
        if (capability === "memory.search") {
          const query = String(args?.query ?? "");
          const streamId =
            typeof args?.streamId === "string" ? args.streamId : undefined;
          const limit = typeof args?.limit === "number" ? args.limit : undefined;
          return await searchMemory(principal, query, { streamId, limit });
        }
        if (capability === "memory.promote") {
          const memoryId = String(args?.memoryId ?? "");
          const summary =
            typeof args?.summary === "string" ? args.summary : undefined;
          return { unit: await promoteMemory(principal, memoryId, summary) };
        }
        if (capability === "search.query") {
          const query = String(args?.query ?? "");
          const entityTypes = Array.isArray(args?.entityTypes)
            ? (args.entityTypes as Array<
                "actor" | "channel" | "thread" | "message" | "memory"
              >)
            : undefined;
          const streamId =
            typeof args?.streamId === "string" ? args.streamId : undefined;
          const actorType =
            args?.actorType === "human" ||
            args?.actorType === "agent" ||
            args?.actorType === "app"
              ? (args.actorType as "human" | "agent" | "app")
              : undefined;
          const limit = typeof args?.limit === "number" ? args.limit : undefined;
          return await searchEntities(principal, query, {
            entityTypes,
            streamId,
            actorType,
            limit,
          });
        }
        return { ok: false };
      },
    }) as unknown as ReturnType<typeof organization>,
  ],
});

type AuthApiMethod = (input: { headers: Headers }) => Promise<unknown>;

function getAuthApiMethod(name: string): AuthApiMethod {
  const method = (auth.api as Record<string, unknown>)[name];
  if (typeof method !== "function") {
    throw new Error(`auth api method unavailable: ${name}`);
  }
  return method as AuthApiMethod;
}

export async function getAgentConfiguration(
  headers: Headers,
): Promise<unknown> {
  return getAuthApiMethod("getAgentConfiguration")({ headers });
}

export async function getAgentSession(headers: Headers): Promise<unknown> {
  return getAuthApiMethod("getAgentSession")({ headers });
}
