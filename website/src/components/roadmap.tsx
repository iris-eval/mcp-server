"use client";

import { useRef } from "react";
import Link from "next/link";
import { motion, useReducedMotion, useInView } from "framer-motion";

interface MilestoneRow {
  v: string;
  status: "Released" | "In progress" | "Planned";
  title: string;
  detail: string;
  // A measurement claim in `detail` must point at the measurement — the
  // hardcoded-claim scanner (measurement-claim-without-link) enforces it.
  proof?: { href: string; label: string };
}

const MILESTONES: MilestoneRow[] = [
  { v: "v0.1", status: "Released", title: "Core MCP Server", detail: "3 tools, initial 12-rule library, SQLite storage, web dashboard, production security" },
  { v: "v0.2", status: "Released", title: "Eval Sensitivity + Security Hardening", detail: "Smart rule exclusion, configurable thresholds, SQL whitelist, CSP headers, accessibility" },
  { v: "v0.3", status: "Released", title: "Dashboard Phase-1 + Pricing", detail: "OKLCH palette, dark/light theme, trace-ID copy, eval sparkline, pricing page, MCP-native validation harness" },
  { v: "v0.3.1", status: "Released", title: "Rule Library Expansion", detail: "13 eval rules (added no_stub_output), 10 PII patterns (IBAN, DOB, MRN, IP, API key, passport), 13 injection patterns, fabricated-citation heuristic, 55-case CI regression gate" },
  { v: "v0.4", status: "Released", title: "LLM-as-Judge + Citation Verify + OTel + 9-tool MCP Surface", detail: "9 MCP tools — full rule + trace lifecycle + LLM-as-judge + SSRF-guarded citation verification (list_rules, deploy_rule, delete_rule, delete_trace, evaluate_with_llm_judge, verify_citations added); LLM-as-judge eval (Claude/GPT-4o, cost-capped, 5 prompt templates); semantic citation verification (4 citation kinds — numbered/author-year/URL/DOI — SSRF-guarded fetch + per-claim LLM verdict); OpenTelemetry export; tenant-id scaffolding; SBOM + cosign signing; Playwright E2E; Lighthouse CI; v2.C chrome polish" },
  { v: "v0.4.6", status: "Released", title: "Security + Data Integrity", detail: "Dashboard bound to loopback with a DNS-rebinding guard; two ReDoS vectors closed (built-in PII patterns, and a deploy-time backtracking probe that catches what safe-regex2 misses); evaluations no longer dropped from time windows by a timestamp-format mismatch; the rule store no longer discards valid rules when one is unparseable; safety violations now counted even when the overall eval passes" },
  { v: "v0.5.0", status: "Released", title: "The Acceptance-Test Release", detail: "Critical-rule veto — a detected PII leak, prompt injection or blocklist hit forces passed:false regardless of the weighted score and names itself in critical_failures; ReDoS sandbox worker with a hard 100ms per-match deadline plus a 3-breach-per-evaluation circuit breaker; strict tool arguments, so an unrecognised key fails the call instead of silently changing what gets evaluated; the safety-rule family measured against a labeled corpus and rebuilt (vendor-credential detection, structural injection detectors, context-grounded hallucination signals); POST /api/v1/traces HTTP ingest; --demo and --self-test; failure-first dashboard, now started only when explicitly enabled", proof: { href: "/proof", label: "That corpus was private and in-sample — the public per-rule numbers live on the proof page" } },
  { v: "v0.6.0", status: "Released", title: "The Correctness Release", detail: "Every open item from the v0.5.0 acceptance pass closed and proven by a 52-row pre-release acceptance run: evaluate_output eval_type \"all\" runs every bundle in one pass with a per-category breakdown; deployed rules can be paused and resumed without deleting them; a browser can sign in to an --api-key dashboard; --version and --purge; retention sweeps stored evaluations; same-name deploy_rule refused unless replace: true; impossible get_traces ranges refused naming the values; the release workflow publishes to the Official MCP Registry and verifies npm, GHCR, the GitHub release and the registry from outside before it reports green." },
  { v: "Track 1", status: "In progress", title: "Proof — measure our own evaluators", detail: "Labeled golden corpora per rule with published inter-annotator agreement; per-rule precision, recall and confusion matrices; chance-corrected agreement alongside raw; confidence intervals; adversarial false-positive rates for the judge path; one-command reproduction with pinned models and dataset checksums; results versioned per release and gated in CI — including where our own rules are weak", proof: { href: "/proof", label: "The proof page — method, per-rule numbers with 95% confidence intervals as they land, and the command to reproduce them" } },
  { v: "Track 2", status: "In progress", title: "Coverage — evaluate what actually fails", detail: "Hallucination-marker rule corrected (context-grounded fabrication/contradiction signals shipped v0.5.0, with a first single-output false-success signal); loop and non-termination rules; trace ingestion via OpenTelemetry GenAI semantic conventions; verification auditing; data-flow injection checks" },
  { v: "Track 3", status: "In progress", title: "Reach — use Iris from anywhere", detail: "HTTP write endpoints shipped in v0.5.0 — POST /api/v1/traces accepts the same contract as the log_trace tool, so any language, runtime or CI job can send traces and evaluations (a batch shape and a dedicated POST /evaluations route are still open). Still planned: a CLI for quality gates and batch evaluation; SDKs for guaranteed capture; datasets and run comparison. MCP stays the interactive path — under the protocol a tool call is always the model's decision, so anything that must be recorded needs a path that does not depend on it" },
];

function Milestone({ m, index }: { m: MilestoneRow; index: number }): React.ReactElement {
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
      {m.proof && (
        <p className="mt-2 text-[13px] leading-relaxed text-text-muted">
          <Link href={m.proof.href} className="font-semibold text-text-accent hover:underline">
            {m.proof.label} &rarr;
          </Link>
        </p>
      )}
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
