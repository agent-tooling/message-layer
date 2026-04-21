import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { MessageLayerClient } from "./ml.js";

/**
 * Three message-layer tools exposed to the Mastra agent:
 *   - list_channels     : discover channels the agent can see
 *   - create_channel    : attempt to create one; surfaces permission denials
 *   - post_message      : post a text message by channel id or name
 *
 * Every tool returns a structured shape that encodes both the success case
 * and the "you were denied, a permission request is waiting for a human"
 * case, so the LLM can narrate what's happening back into the terminal.
 */

const channelShape = z.object({
  id: z.string(),
  name: z.string(),
  visibility: z.enum(["public", "private"]),
});

export function makePoetTools(client: MessageLayerClient) {
  const listChannels = createTool({
    id: "list_channels",
    description:
      "List every channel this agent can see in the current org. Use this first when asked to post to a named channel so you can resolve the name to an id. Use the returned list before trying to create a channel.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      channels: z.array(channelShape),
    }),
    execute: async () => {
      const channels = await client.listChannels();
      return {
        channels: channels.map((c) => ({ id: c.id, name: c.name, visibility: c.visibility })),
      };
    },
  });

  const createChannel = createTool({
    id: "create_channel",
    description:
      "Create a new channel in the current org. Returns { ok: true, channelId } on success, or { ok: false, permissionRequestId } if the agent lacks the `channel:create` capability — in which case a permission request has been opened for a human to approve. Do not retry immediately; report the pending request and move on.",
    inputSchema: z.object({
      name: z.string().min(1).describe("Channel name (e.g. 'poems')"),
      visibility: z.enum(["public", "private"]).default("public"),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      channelId: z.string().optional(),
      code: z.string().optional(),
      message: z.string().optional(),
      permissionRequestId: z.string().optional(),
      capability: z.string().optional(),
    }),
    execute: async ({ name, visibility }) => {
      const result = await client.createChannel(name, visibility);
      if (result.ok) return { ok: true, channelId: result.channelId };
      return {
        ok: false,
        code: result.code,
        message: result.message,
        permissionRequestId: result.requestId,
        capability: result.capability,
      };
    },
  });

  const postMessage = createTool({
    id: "post_message",
    description:
      "Post a short text message to a channel identified by id OR by name. If the channel does not exist, return an error — do not create it (that is the job of create_channel). If appending is denied, a permission request is auto-opened and its id is returned.",
    inputSchema: z.object({
      channel: z.string().describe("Channel id (32-hex) or channel name (e.g. 'poems')"),
      text: z.string().min(1).max(1000),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      messageId: z.string().optional(),
      streamSeq: z.number().optional(),
      code: z.string().optional(),
      message: z.string().optional(),
      permissionRequestId: z.string().optional(),
      capability: z.string().optional(),
      resolvedChannelId: z.string().optional(),
    }),
    execute: async ({ channel, text }) => {
      const looksLikeId = /^[0-9a-f]{32}$/i.test(channel);
      let streamId = channel;
      if (!looksLikeId) {
        const channels = await client.listChannels();
        const match = channels.find((c) => c.name === channel);
        if (!match) {
          return {
            ok: false,
            code: "not_found",
            message: `no channel named "${channel}" is visible to this agent`,
          };
        }
        streamId = match.id;
      }

      const result = await client.appendMessage({
        streamId,
        streamType: "channel",
        text,
      });

      if (result.ok) {
        return {
          ok: true,
          messageId: result.messageId,
          streamSeq: result.streamSeq,
          resolvedChannelId: streamId,
        };
      }
      return {
        ok: false,
        code: result.code,
        message: result.message,
        permissionRequestId: result.requestId,
        capability: result.capability,
        resolvedChannelId: streamId,
      };
    },
  });

  return { listChannels, createChannel, postMessage };
}
