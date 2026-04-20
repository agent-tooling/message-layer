import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Smoke tests and the documented dev workflow hit the client at
  // `http://127.0.0.1:3001`, while Next.js dev binds to `localhost`. Without
  // this allowlist, Next.js 16 refuses to serve dev-only resources (HMR
  // client chunks, the `/__nextjs_font` worker) to the "cross-origin" host,
  // which breaks hydration and leaves the app stuck on "Loading session...".
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
