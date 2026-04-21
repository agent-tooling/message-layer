import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { MessageLayerClient } from "./ml.js";

export function makeAssistantTools(client: MessageLayerClient) {
  const listChannels = createTool({
    id: "list_channels",
    description: "List channels visible to this assistant.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      channels: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          visibility: z.enum(["public", "private"]),
        }),
      ),
    }),
    execute: async () => {
      const channels = await client.listChannels();
      return { channels };
    },
  });

  const createChannel = createTool({
    id: "create_channel",
    description: "Create a channel when asked to set up a workspace.",
    inputSchema: z.object({
      name: z.string().min(1),
      visibility: z.enum(["public", "private"]).default("public"),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      channelId: z.string().optional(),
      message: z.string().optional(),
      permissionRequestId: z.string().optional(),
      capability: z.string().optional(),
    }),
    execute: async ({ name, visibility }) => {
      const created = await client.createChannel(name, visibility);
      if (created.ok) {
        return { ok: true, channelId: created.channelId };
      }
      return {
        ok: false,
        message: created.message,
        permissionRequestId: created.requestId,
        capability: created.capability,
      };
    },
  });

  const postMessage = createTool({
    id: "post_message",
    description: "Post a message into a channel by id or name.",
    inputSchema: z.object({
      channel: z.string().min(1),
      text: z.string().min(1).max(1500),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      messageId: z.string().optional(),
      streamSeq: z.number().optional(),
      message: z.string().optional(),
      permissionRequestId: z.string().optional(),
      capability: z.string().optional(),
      resolvedChannelId: z.string().optional(),
    }),
    execute: async ({ channel, text }) => {
      const looksLikeId = /^[0-9a-f]{32}$/i.test(channel);
      let channelId = channel;
      if (!looksLikeId) {
        const channels = await client.listChannels();
        const match = channels.find((item) => item.name === channel);
        if (!match) {
          return { ok: false, message: `channel '${channel}' not found` };
        }
        channelId = match.id;
      }
      const posted = await client.appendMessage({
        streamId: channelId,
        streamType: "channel",
        text,
      });
      if (posted.ok) {
        return {
          ok: true,
          messageId: posted.messageId,
          streamSeq: posted.streamSeq,
          resolvedChannelId: channelId,
        };
      }
      return {
        ok: false,
        message: posted.message,
        permissionRequestId: posted.requestId,
        capability: posted.capability,
        resolvedChannelId: channelId,
      };
    },
  });

  return { listChannels, createChannel, postMessage };
}
