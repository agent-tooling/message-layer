import { z } from "zod";

const envSchema = z.object({
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3001"),
  BETTER_AUTH_SECRET: z.string().min(16).default("change-me-to-a-secure-secret"),
  MESSAGE_LAYER_BASE_URL: z.string().url().default("http://127.0.0.1:3000"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3001"),
  DEFAULT_ORG_NAME: z.string().min(1).default("Agent Tooling Team"),
  DEFAULT_CHANNEL_NAME: z.string().min(1).default("general"),
});

export const env = envSchema.parse({
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  MESSAGE_LAYER_BASE_URL: process.env.MESSAGE_LAYER_BASE_URL,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  DEFAULT_ORG_NAME: process.env.DEFAULT_ORG_NAME,
  DEFAULT_CHANNEL_NAME: process.env.DEFAULT_CHANNEL_NAME,
});
