import type { Metadata } from "next";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";

export const metadata: Metadata = {
  title: "Badges — Iris",
  description: "Embeddable badges and trust signals for Iris MCP Server.",
  robots: { index: false, follow: false },
};

const GLAMA_BASE = "https://glama.ai/mcp/servers/iris-eval/mcp-server";
const SHIELDS_BASE = "https://img.shields.io";

const BADGES = [
  {
    label: "Glama Score (AAA)",
    img: `${GLAMA_BASE}/badges/score.svg`,
    link: GLAMA_BASE,
    markdown: `[![Glama Score](${GLAMA_BASE}/badges/score.svg)](${GLAMA_BASE})`,
  },
  {
    label: "Glama Card",
    img: `${GLAMA_BASE}/badges/card.svg`,
    link: GLAMA_BASE,
    markdown: `[![mcp-server MCP server](${GLAMA_BASE}/badges/card.svg)](${GLAMA_BASE})`,
  },
  {
    label: "npm version",
    img: `${SHIELDS_BASE}/npm/v/@iris-eval/mcp-server`,
    link: "https://npmjs.com/package/@iris-eval/mcp-server",
    markdown: `[![npm version](${SHIELDS_BASE}/npm/v/@iris-eval/mcp-server)](https://npmjs.com/package/@iris-eval/mcp-server)`,
  },
  {
    label: "npm total downloads",
    img: `${SHIELDS_BASE}/npm/dt/@iris-eval/mcp-server`,
    link: "https://npmjs.com/package/@iris-eval/mcp-server",
    markdown: `[![npm downloads](${SHIELDS_BASE}/npm/dt/@iris-eval/mcp-server)](https://npmjs.com/package/@iris-eval/mcp-server)`,
  },
  {
    label: "GitHub stars",
    img: `${SHIELDS_BASE}/github/stars/iris-eval/mcp-server?style=social`,
    link: "https://github.com/iris-eval/mcp-server",
    markdown: `[![GitHub stars](${SHIELDS_BASE}/github/stars/iris-eval/mcp-server?style=social)](https://github.com/iris-eval/mcp-server)`,
  },
  {
    label: "CI status",
    img: "https://github.com/iris-eval/mcp-server/actions/workflows/ci.yml/badge.svg",
    link: "https://github.com/iris-eval/mcp-server/actions/workflows/ci.yml",
    markdown: `[![CI](https://github.com/iris-eval/mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/iris-eval/mcp-server/actions/workflows/ci.yml)`,
  },
  {
    label: "License (MIT)",
    img: `${SHIELDS_BASE}/badge/License-MIT-blue.svg`,
    link: "https://github.com/iris-eval/mcp-server/blob/main/LICENSE",
    markdown: `[![License: MIT](${SHIELDS_BASE}/badge/License-MIT-blue.svg)](https://github.com/iris-eval/mcp-server/blob/main/LICENSE)`,
  },
  {
    label: "Docker",
    img: `${SHIELDS_BASE}/badge/Docker-ghcr.io-blue?logo=docker`,
    link: "https://github.com/iris-eval/mcp-server/pkgs/container/mcp-server",
    markdown: `[![Docker](${SHIELDS_BASE}/badge/Docker-ghcr.io-blue?logo=docker)](https://github.com/iris-eval/mcp-server/pkgs/container/mcp-server)`,
  },
];

export default function BadgesPage() {
  return (
    <>
      <Nav />
      <main className="mx-auto max-w-3xl px-6 py-20">
        <h1 className="mb-2 text-2xl font-bold text-text-primary">Badges</h1>
      <p className="mb-10 text-text-secondary">
        Embeddable trust signals for Iris. Copy the markdown to use in articles,
        READMEs, or directory listings.
      </p>

      <div className="space-y-8">
        {BADGES.map((b) => (
          <div key={b.label} className="rounded-xl border border-border-default bg-bg-surface/60 p-5">
            <p className="mb-3 text-sm font-semibold text-text-primary">{b.label}</p>
            <a href={b.link} target="_blank" rel="noopener noreferrer" className="mb-4 inline-block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={b.img} alt={b.label} />
            </a>
            <pre className="overflow-x-auto rounded-lg bg-bg-base p-3 text-xs text-text-secondary">
              {b.markdown}
            </pre>
          </div>
        ))}
      </div>
    </main>
    <Footer />
    </>
  );
}
