import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": here,
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 20000,
  },
});
