"use client";

import { motion, useReducedMotion, useInView } from "framer-motion";
import { useRef } from "react";

const USE_CASES = [
  {
    audience: "Developers shipping MCP agents",
    problem: "You deployed an agent and you have no idea what it's doing.",
    solution: "Iris traces every execution, tool call, and token automatically. No SDK. No code changes. Add it to your MCP config and start seeing everything.",
    metric: "60s",
    metricLabel: "to first trace",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
      </svg>
    ),
  },
  {
    audience: "Teams monitoring agent costs",
    problem: "Your agent burned $0.47 on a single query and your APM showed 200 OK.",
    solution: "Iris tracks cost per trace, per agent, per time window. Set budget thresholds and get flagged when agents overspend — before finance finds out.",
    metric: "$0.07",
    metricLabel: "avg cost visibility per trace",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
      </svg>
    ),
  },
  {
    audience: "Companies preventing PII leaks",
    problem: "Your agent leaked a Social Security number in its output and nobody noticed for 3 months.",
    solution: "Iris evaluates every output against 13 built-in rules including PII detection across 10 patterns (SSN, credit card, phone, email, IBAN, DOB, medical record number, IP address, API key, passport), prompt injection (13 patterns), stub-output detection, and hallucination markers. Real-time, every trace.",
    metric: "13",
    metricLabel: "built-in eval rules",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
  },
];

export function BuiltFor(): React.ReactElement {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });
  const reduce = useReducedMotion();

  return (
    <section ref={ref} className="relative bg-bg-raised py-32 lg:py-44" id="built-for">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">
            Built for
          </p>
          <h2 className="mt-4 font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl lg:text-6xl">
            Three problems.{" "}
            <span className="text-gradient">One MCP server.</span>
          </h2>
          <p className="mt-6 text-lg leading-relaxed text-text-secondary md:text-xl">
            Every team building AI agents hits the same walls. Iris was built
            to tear them down — without touching your code.
          </p>
        </div>

        {/* Use case cards — asymmetric: first card is hero-width, next two are side by side */}
        <div className="mt-16 space-y-6 lg:mt-20">
          {/* Lead card — full width */}
          <motion.div
            initial={reduce ? {} : { opacity: 0, y: 20 }}
            animate={inView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.5 }}
            className="relative overflow-hidden rounded-2xl p-8 md:p-10"
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border-glow)",
              boxShadow: "0 0 48px var(--glow-primary)",
            }}
          >
            <div className="grid gap-8 lg:grid-cols-[1fr_auto]">
              <div>
                <div className="mb-4 inline-flex items-center gap-2 text-text-accent">
                  {USE_CASES[0].icon}
                  <span className="text-[13px] font-semibold uppercase tracking-wider">
                    {USE_CASES[0].audience}
                  </span>
                </div>
                <p className="text-[15px] font-medium text-text-primary italic">
                  &ldquo;{USE_CASES[0].problem}&rdquo;
                </p>
                <p className="mt-4 text-[15px] leading-relaxed text-text-secondary">
                  {USE_CASES[0].solution}
                </p>
              </div>
              <div className="flex items-center justify-center lg:min-w-[160px]">
                <div className="text-center">
                  <div className="font-display text-5xl font-extrabold text-text-accent">
                    {USE_CASES[0].metric}
                  </div>
                  <div className="mt-1 text-[13px] text-text-muted">
                    {USE_CASES[0].metricLabel}
                  </div>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Secondary cards — side by side */}
          <div className="grid gap-6 md:grid-cols-2">
            {USE_CASES.slice(1).map((uc, i) => (
              <motion.div
                key={uc.audience}
                initial={reduce ? {} : { opacity: 0, y: 20 }}
                animate={inView ? { opacity: 1, y: 0 } : {}}
                transition={{ duration: 0.5, delay: 0.1 + i * 0.1 }}
                className="glow-border card-premium flex flex-col overflow-hidden p-8"
              >
                <div className="mb-4 inline-flex items-center gap-2 text-text-accent">
                  {uc.icon}
                  <span className="text-[13px] font-semibold uppercase tracking-wider">
                    {uc.audience}
                  </span>
                </div>
                <p className="text-[15px] font-medium text-text-primary italic">
                  &ldquo;{uc.problem}&rdquo;
                </p>
                <p className="mt-4 flex-1 text-[14px] leading-relaxed text-text-secondary">
                  {uc.solution}
                </p>
                <div className="mt-6 border-t border-border-subtle pt-5">
                  <span className="font-display text-3xl font-extrabold text-text-accent">
                    {uc.metric}
                  </span>
                  <span className="ml-2 text-[13px] text-text-muted">
                    {uc.metricLabel}
                  </span>
                </div>
              </motion.div>
            ))}
          </div>
        </div>

        {/* Community traction — real, verifiable signals */}
        <div className="mt-16 rounded-2xl border border-border-default bg-bg-card p-8 text-center lg:mt-20">
          <p className="text-[12px] font-bold uppercase tracking-[0.2em] text-text-muted">
            Join the community
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-6 md:gap-10">
            <a
              href="https://github.com/iris-eval/mcp-server"
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-2 text-text-secondary transition-colors hover:text-text-primary"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
              <span className="text-[14px] font-medium">Star on GitHub</span>
            </a>
            <span
              className="group flex cursor-default items-center gap-2 text-text-muted"
              title="Discord coming soon"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03z"/></svg>
              <span className="text-[14px] font-medium">Discord <span className="text-[11px]">(coming soon)</span></span>
            </span>
            <a
              href="https://x.com/iris_eval"
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-2 text-text-secondary transition-colors hover:text-text-primary"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
              <span className="text-[14px] font-medium">Follow @iris_eval</span>
            </a>
            <a
              href="https://www.npmjs.com/package/@iris-eval/mcp-server"
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-2 text-text-secondary transition-colors hover:text-text-primary"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.499h-3.464l.01-10.026h-3.456L12.04 18.84H5.113z"/></svg>
              <span className="text-[14px] font-medium">View on npm</span>
            </a>
            <a
              href="https://cursor.directory/plugins/iris"
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-2 text-text-secondary transition-colors hover:text-text-primary"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.5 0A2.5 2.5 0 000 2.5v19A2.5 2.5 0 002.5 24h19a2.5 2.5 0 002.5-2.5v-19A2.5 2.5 0 0021.5 0h-19zm9.5 4l8 8-8 8-2-2 6-6-6-6 2-2z"/></svg>
              <span className="text-[14px] font-medium">Cursor Directory</span>
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
