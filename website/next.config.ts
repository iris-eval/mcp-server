import type { NextConfig } from "next";

const STATIC_CSP = [
  "default-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  trailingSlash: false,
  reactCompiler: true,
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
        {
          key: "Permissions-Policy",
          value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
        },
      ],
    },
    // Pages get a per-request nonce policy from src/proxy.ts. Everything the
    // proxy skips — the API, built assets, and files served from public/ —
    // gets this fixed policy, which runs no script at all: none of those
    // responses is a page that needs one, and an SVG or HTML file opened
    // directly cannot run any.
    ...["/api/:path*", "/_next/:path*", "/:path*\\.:ext([a-zA-Z0-9]+)"].map((source) => ({
      source,
      headers: [{ key: "Content-Security-Policy", value: STATIC_CSP }],
    })),
  ],
  redirects: async () => [
    {
      source: "/:path*",
      has: [{ type: "host", value: "www.iris-eval.com" }],
      destination: "https://iris-eval.com/:path*",
      permanent: true,
    },
    {
      source: "/waitlist",
      destination: "/#waitlist",
      permanent: true,
    },
    // The capability map IS the roadmap: every question Iris
    // can be asked against every subject, with what it has, what it has
    // with a stated limit, and what it lacks — rendered from the truthbase
    // at every release and drift-locked, so it cannot describe the product
    // as older or newer than it is. docs/roadmap.md said the same thing in
    // prose that went stale between releases; it is gone, and the links
    // that pointed at it land here.
    {
      source: "/roadmap",
      destination: "/capabilities",
      permanent: true,
    },
    // The dashboard's command palette ("Open Iris docs") and older listings
    // link to iris-eval.com/docs. The docs live in the repo; send readers
    // there until a hosted docs site exists. Temporary on purpose.
    {
      source: "/docs",
      destination: "https://github.com/iris-eval/mcp-server/tree/main/docs",
      permanent: false,
    },
    {
      source: "/docs/:path*",
      destination: "https://github.com/iris-eval/mcp-server/blob/main/docs/:path*",
      permanent: false,
    },
  ],
};

export default nextConfig;
