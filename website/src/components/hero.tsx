"use client";

import { motion, useReducedMotion } from "framer-motion";
import { DashboardMockup } from "./dashboard-mockup";
import { RotatingWords } from "./rotating-words";

const COMPAT = ["Claude Desktop", "Cursor", "Claude Code", "Windsurf", "LangChain", "CrewAI", "MCP SDK", "AutoGen"];

const BADGES = [
  { src: "https://glama.ai/mcp/servers/iris-eval/mcp-server/badges/score.svg", alt: "Glama Score", href: "https://glama.ai/mcp/servers/iris-eval/mcp-server" },
  { src: "https://img.shields.io/badge/Cursor_Directory-Listed-171717?style=flat-square", alt: "Cursor Directory", href: "https://cursor.directory/plugins/iris" },
  { src: "https://img.shields.io/npm/v/@iris-eval/mcp-server?style=flat-square&color=0d9488&label=npm", alt: "npm version", href: "https://www.npmjs.com/package/@iris-eval/mcp-server" },
  { src: "https://img.shields.io/npm/dt/@iris-eval/mcp-server?style=flat-square&color=0d9488&label=downloads", alt: "npm downloads", href: "https://www.npmjs.com/package/@iris-eval/mcp-server" },
  { src: "https://img.shields.io/github/stars/iris-eval/mcp-server?style=flat-square&color=0d9488", alt: "GitHub stars", href: "https://github.com/iris-eval/mcp-server" },
  { src: "https://img.shields.io/github/actions/workflow/status/iris-eval/mcp-server/ci.yml?style=flat-square&label=CI", alt: "CI status", href: "https://github.com/iris-eval/mcp-server/actions" },
  { src: "https://img.shields.io/badge/license-MIT-22c55e?style=flat-square", alt: "MIT License", href: "https://github.com/iris-eval/mcp-server/blob/main/LICENSE" },
];

export function Hero(): React.ReactElement {
  const reduce = useReducedMotion();

  return (
    <section className="relative overflow-hidden">
      <div className="glow-hero absolute top-[-300px] left-1/2 -translate-x-1/2" aria-hidden="true" />
      <div className="glow-hero absolute top-[200px] right-[-300px] opacity-30" aria-hidden="true" />

      <div className="bg-grid relative mx-auto max-w-7xl px-6 pt-24 pb-16 lg:px-8 lg:pt-36 lg:pb-24">
        <motion.div
          initial={reduce ? {} : { opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="mx-auto max-w-4xl text-center"
        >
          {/* Open Source badge pill */}
          <div className="mb-6 inline-flex items-center gap-2.5 rounded-full border border-border-default bg-bg-raised/80 px-4 py-1.5 backdrop-blur-sm">
            <span className="pulse-dot inline-block h-2 w-2 rounded-full bg-eval-pass" />
            <span className="font-mono text-[13px] text-text-secondary">
              Open Source
            </span>
          </div>

          {/* Badges row — Glama AAA leads, then shields.io */}
          <div className="mb-8 flex flex-wrap items-center justify-center gap-2">
            {BADGES.map((b) => (
              <a key={b.alt} href={b.href} target="_blank" rel="noopener noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={b.src} alt={b.alt} height={20} className="h-5" />
              </a>
            ))}
          </div>

          {/* Headline — line 1 static, line 2 rotating */}
          <h1 className="font-display text-3xl leading-[1.15] font-extrabold tracking-tight sm:text-4xl md:text-5xl lg:text-6xl">
            <span className="block text-text-primary">
              See what your AI agents are
            </span>
          </h1>
          <div className="mt-2 font-display text-4xl leading-[1.3] font-extrabold tracking-tight sm:text-5xl md:text-6xl lg:text-[72px]">
            <RotatingWords />
          </div>

          <p className="mx-auto mt-8 max-w-2xl text-lg leading-relaxed text-text-secondary md:text-[20px]">
            The agent eval standard for MCP. Install once. Every agent
            auto-discovers it. Zero SDK. Decision Moments classify what matters,
            so safety violations and cost spikes surface before happy-path passes.
          </p>

          {/* CTAs */}
          <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <a href="#open-source" className="group inline-flex items-center rounded-xl bg-iris-600 px-8 py-4 text-[15px] font-semibold text-white shadow-lg shadow-iris-600/20 transition-all hover:bg-iris-500 hover:shadow-iris-500/30">
              Get Started
              <svg className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-0.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 8h10M9 4l4 4-4 4"/></svg>
            </a>
            <a href="#waitlist" className="inline-flex items-center rounded-xl border border-border-default px-8 py-4 text-[15px] font-semibold text-text-secondary transition-all hover:border-border-glow hover:text-text-primary hover:shadow-[0_0_24px_var(--glow-primary)]">
              Join Cloud Waitlist
            </a>
          </div>

          {/* Install command */}
          <div className="mx-auto mt-8 max-w-md rounded-xl border border-border-default bg-bg-surface/60 px-5 py-3.5 font-mono text-[14px] backdrop-blur-sm">
            <span className="select-none text-text-muted">$ </span>
            <span className="text-text-primary">npx @iris-eval/mcp-server</span>
          </div>

          {/* Validated-by proof row (B7) — surfaces the real evidence behind
              the headline so visitors who hover over "agent eval standard"
              see what's actually shipped. */}
          <div className="mx-auto mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[12px] text-text-muted">
            <span className="font-mono">
              <span className="text-text-secondary font-semibold">13 rules</span>
              <span> · regression-protected CI</span>
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">
              <span className="text-text-secondary font-semibold">5 real-domain case studies</span>
              <span> · executed end-to-end through MCP</span>
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">
              <span className="text-text-secondary font-semibold">249 tests</span>
              <span> · all green</span>
            </span>
          </div>
        </motion.div>

        {/* Dashboard mockup */}
        <motion.div
          initial={reduce ? {} : { opacity: 0, y: 40, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.8, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="relative mx-auto mt-16 max-w-5xl lg:mt-20"
        >
          <div className="absolute -inset-4 rounded-3xl bg-gradient-to-b from-iris-500/10 to-transparent blur-2xl" aria-hidden="true" />
          <DashboardMockup />
        </motion.div>

        {/* Compatibility marquee */}
        <div className="mt-20 border-t border-border-subtle pt-10">
          <p className="mb-6 text-center text-[11px] font-bold uppercase tracking-[0.2em] text-text-muted">
            Works with any MCP-compatible agent
          </p>
          <div className="relative overflow-hidden">
            <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-32 bg-gradient-to-r from-bg-base to-transparent" />
            <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-32 bg-gradient-to-l from-bg-base to-transparent" />
            <div className="animate-marquee flex w-max gap-14">
              {[...COMPAT, ...COMPAT].map((t, i) => (
                <span key={`${t}-${i}`} className="whitespace-nowrap font-mono text-[14px] font-medium text-text-muted">{t}</span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
