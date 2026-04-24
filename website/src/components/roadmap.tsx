"use client";

import { useRef } from "react";
import { motion, useReducedMotion, useInView } from "framer-motion";

const MILESTONES = [
  { v: "v0.1", status: "Released", title: "Core MCP Server", detail: "3 tools, initial 12-rule library, SQLite storage, web dashboard, production security" },
  { v: "v0.2", status: "Released", title: "Eval Sensitivity + Security Hardening", detail: "Smart rule exclusion, configurable thresholds, SQL whitelist, CSP headers, accessibility" },
  { v: "v0.3", status: "Released", title: "Dashboard Phase-1 + Pricing", detail: "OKLCH palette, dark/light theme, trace-ID copy, eval sparkline, pricing page, MCP-native validation harness" },
  { v: "v0.3.1", status: "Released", title: "Rule Library Expansion", detail: "13 eval rules (added no_stub_output), 10 PII patterns (IBAN, DOB, MRN, IP, API key, passport), 13 injection patterns, fabricated-citation heuristic, 55-case CI regression gate" },
  { v: "v0.4", status: "Planned", title: "LLM-as-Judge + OTel + 7-tool MCP Surface", detail: "7 MCP tools — full rule + trace lifecycle (list_rules, deploy_rule, delete_rule, delete_trace added); LLM-as-judge eval (Claude/GPT-4o, cost-capped); semantic citation verification; OpenTelemetry export; tenant-id scaffolding; SBOM + cosign signing; Playwright E2E; Lighthouse CI; v2.C chrome polish" },
  { v: "v0.5", status: "Planned", title: "Cloud Tier", detail: "Managed Iris — PostgreSQL adapter, full multi-tenancy with user accounts + workspace isolation, team eval dashboards, usage-based billing" },
  { v: "v0.6", status: "Planned", title: "Alerting & Retention", detail: "Alert rules, webhooks, email notifications, retention policies, drift detection" },
  { v: "v0.7", status: "Planned", title: "Enterprise", detail: "SSO/SAML, RBAC, audit logs export, SOC 2 compliance" },
];

function Milestone({ m, index }: { m: typeof MILESTONES[0]; index: number }): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  const reduce = useReducedMotion();
  const released = m.status === "Released";

  return (
    <motion.div
      ref={ref}
      initial={reduce ? {} : { opacity: 0, x: -16 }}
      animate={inView ? { opacity: 1, x: 0 } : {}}
      transition={{ duration: 0.4, delay: index * 0.1 }}
      className={`relative ${index < MILESTONES.length - 1 ? "pb-12" : ""}`}
    >
      <div
        className={`absolute -left-[calc(2.5rem+5px)] top-1 h-4 w-4 rounded-full border-2 md:-left-[calc(3rem+5px)] ${
          released
            ? "border-iris-500 bg-iris-500 shadow-[0_0_12px_var(--iris-500)]"
            : "border-border-strong bg-bg-base"
        }`}
      />
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-[14px] font-bold text-text-accent">{m.v}</span>
        <span
          className={`rounded-full px-3 py-0.5 text-[11px] font-bold ${
            released ? "bg-eval-pass/10 text-eval-pass" : "bg-border-subtle text-text-muted"
          }`}
        >
          {m.status}
        </span>
      </div>
      <h3 className="mt-2 font-display text-lg font-bold text-text-primary md:text-xl">{m.title}</h3>
      <p className="mt-1 text-[14px] leading-relaxed text-text-secondary">{m.detail}</p>
    </motion.div>
  );
}

export function Roadmap(): React.ReactElement {
  return (
    <section className="py-32 lg:py-44" id="roadmap">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">
            Roadmap
          </p>
          <h2 className="mt-4 font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl">
            Built in public. <span className="text-gradient">Shipping fast.</span>
          </h2>
        </div>

        <div className="mx-auto mt-16 max-w-2xl lg:mt-20">
          <div className="relative border-l-2 border-border-default pl-10 md:pl-12">
            {MILESTONES.map((m, i) => (
              <Milestone key={m.v} m={m} index={i} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
