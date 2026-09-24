import type { NextConfig } from "next";

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
          key: "Content-Security-Policy",
          value: [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: https:",
            "font-src 'self'",
            "connect-src 'self' https://iris-eval.com",
            "frame-ancestors 'none'",
          ].join("; "),
        },
        {
          key: "Permissions-Policy",
          value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
        },
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
