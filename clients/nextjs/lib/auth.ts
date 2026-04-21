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
  listKnowledge,
  listMessages,
  listStreamArtifacts,
  promoteKnowledge,
  registerArtifact,
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
          description: "Upload an artifact (binary blob) to a channel or thread",
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
          name: "knowledge.list",
          description: "List scoped-knowledge entries derived from a stream",
          input: {
            type: "object",
            required: ["streamId"],
            properties: { streamId: { type: "string" } },
          },
        },
        {
          name: "knowledge.promote",
          description: "Promote a knowledge entry org-wide (requires knowledge:promote grant)",
          input: {
            type: "object",
            required: ["entryId"],
            properties: {
              entryId: { type: "string" },
              summary: { type: "string" },
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
          return { messages: await listMessages(principal, channelId, afterSeq) };
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
          const sha256 = typeof args?.sha256 === "string" ? args.sha256 : undefined;
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
        if (capability === "knowledge.list") {
          const streamId = String(args?.streamId ?? "");
          return { entries: await listKnowledge(principal, streamId) };
        }
        if (capability === "knowledge.promote") {
          const entryId = String(args?.entryId ?? "");
          const summary =
            typeof args?.summary === "string" ? args.summary : undefined;
          return { entry: await promoteKnowledge(principal, entryId, summary) };
        }
        return { ok: false };
      },
    }),
  ],
});
