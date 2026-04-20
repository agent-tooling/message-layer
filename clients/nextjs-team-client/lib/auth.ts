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
  listMessages,
} from "@/lib/message-layer";
import { createInvite } from "@/lib/app-db";

const authDb = new Database(`${process.cwd()}/.data/better-auth.db`);

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
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
        return { ok: false };
      },
    }),
  ],
});
