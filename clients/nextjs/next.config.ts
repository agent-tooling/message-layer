import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@mariozechner/pi-coding-agent",
    "@mariozechner/pi-agent-core",
    "@mariozechner/pi-ai",
    "@mariozechner/pi-tui",
  ],
};

export default nextConfig;
