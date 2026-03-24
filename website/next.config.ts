import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
      ],
    },
  ],
  redirects: async () => [
    {
      source: "/:path*",
      has: [{ type: "host", value: "www.iris-eval.com" }],
      destination: "https://iris-eval.com/:path*",
      permanent: true,
    },
  ],
};

export default nextConfig;
