"use client";

import { useRef } from "react";
import { motion, useReducedMotion, useInView } from "framer-motion";
import { MCP_TOOL_COUNT, RULE_COUNT_BUILT_IN, SUPPORT_EMAIL } from "@/lib/claims";

/*
 * What exists today: the open-source server, so it is the only card. Hosted
 * and team features are under consideration, not under construction, and get
 * a card when they exist.
 */
const FEATURES = [
  `${MCP_TOOL_COUNT} MCP tools — full lifecycle + LLM judge + semantic citation verify (SSRF-guarded)`,
  "LLM-as-judge + citation verify use your own Anthropic/OpenAI API key (BYOK, no proxy)",
  `${RULE_COUNT_BUILT_IN} built-in eval rules + custom rules`,
  "Web dashboard with trace visualization",
  "SQLite storage — zero infrastructure",
  "Production security (auth, rate limiting)",
  "Cost tracking per trace",
  "Docker + npm + npx install",
  "Community support (GitHub Issues + Discussions)",
];

export function Pricing(): React.ReactElement {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });
  const reduce = useReducedMotion();

  return (
    <section ref={ref} className="relative bg-bg-raised py-32 lg:py-44" id="pricing">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        {/* Header */}
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">
            Pricing
          </p>
          <h2 className="mt-4 font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl lg:text-6xl">
            Free to self-host.
          </h2>
          <p className="mt-6 text-lg leading-relaxed text-text-secondary md:text-xl">
            The open-source core is MIT licensed, with no usage limits and no
            account.
          </p>
        </div>

        {/* What exists today */}
        <motion.div
          initial={reduce ? {} : { opacity: 0, y: 20 }}
          animate={inView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.4 }}
          className="card-premium relative mx-auto mt-16 flex max-w-xl flex-col rounded-2xl p-6 lg:mt-20"
        >
          <div className="mb-4 flex items-center gap-2">
            <span className="rounded-full bg-iris-500/10 px-2.5 py-0.5 text-[11px] font-bold text-text-accent">
              Open Source
            </span>
          </div>
          <h3 className="font-display text-lg font-bold text-text-primary">Self-Hosted</h3>
          <div className="mt-3 flex items-baseline gap-1">
            <span className="font-display text-4xl font-extrabold text-text-primary">$0</span>
            <span className="text-[14px] text-text-muted">MIT licensed</span>
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-text-secondary">
            Everything you need to evaluate your MCP agents in production. Your machine, your data, your eval rules.
          </p>
          <div className="mt-6">
            <a
              href="#open-source"
              className="block w-full rounded-xl border border-border-default px-4 py-3 text-center text-[14px] font-semibold text-text-secondary transition-all hover:border-border-glow hover:text-text-primary"
            >
              Get Started
            </a>
          </div>
          <ul className="mt-6 flex-1 space-y-2.5 border-t border-border-subtle pt-6">
            {FEATURES.map((f) => (
              <li key={f} className="flex items-start gap-2.5 text-[13px] text-text-secondary">
                <svg className="mt-0.5 h-4 w-4 shrink-0 text-iris-500" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 8l3.5 3.5L13 5"/></svg>
                {f}
              </li>
            ))}
          </ul>
        </motion.div>

        {/* Bottom note */}
        <p className="mt-10 text-center text-[13px] text-text-muted">
          The self-hosted server includes unlimited eval rules, both transports (stdio + HTTP), and the full API.
          <br />
          If something you need is missing, tell us:{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-text-accent hover:underline">
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
      </div>
    </section>
  );
}
