"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import * as Tabs from "@radix-ui/react-tabs";

const EVAL_ROWS = [
  { cat: "SAFETY", rule: "PII Detection", status: "PASS", score: "1.0" },
  { cat: "SAFETY", rule: "Injection Check", status: "PASS", score: "1.0" },
  { cat: "RELEVANCE", rule: "Topic Consistency", status: "PASS", score: "0.87" },
  { cat: "COMPLETE", rule: "Output Coverage", status: "WARN", score: "0.62" },
  { cat: "COST", rule: "Budget Threshold", status: "FAIL", score: "0.0" },
];

const COST_AGENTS = [
  { name: "research-agent", cost: "$91.74", pct: 72 },
  { name: "code-review-bot", cost: "$22.91", pct: 18 },
  { name: "support-agent", cost: "$12.78", pct: 10 },
];

function Badge({ status }: { status: string }): React.ReactElement {
  const map: Record<string, string> = {
    PASS: "bg-eval-pass/10 text-eval-pass",
    WARN: "bg-eval-warn/10 text-eval-warn",
    FAIL: "bg-eval-fail/10 text-eval-fail",
  };
  return (
    <span className={`inline-flex rounded-md px-2.5 py-1 font-mono text-[11px] font-bold ${map[status] ?? ""}`}>
      {status}
    </span>
  );
}

export function ProductTabs(): React.ReactElement {
  const [active, setActive] = useState("trace");

  return (
    <section className="relative bg-bg-raised py-32 lg:py-44" id="product">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        {/* Header */}
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">
            Product
          </p>
          <h2 className="mt-4 font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl lg:text-6xl">
            Three tools.{" "}
            <span className="text-gradient">One quality standard.</span>
          </h2>
          <p className="mt-6 text-lg leading-relaxed text-text-secondary md:text-xl">
            Iris registers as an MCP server. Your agent discovers it and invokes
            its tools automatically. No SDK. No code changes.
          </p>
        </div>

        {/* Tabs */}
        <Tabs.Root value={active} onValueChange={setActive} className="mt-16 lg:mt-20">
          <div className="flex justify-center">
            <Tabs.List
              className="inline-flex gap-1 rounded-xl border border-border-default bg-bg-base/60 p-1.5 backdrop-blur-sm"
              aria-label="Product features"
            >
              {["trace", "eval", "cost"].map((v) => (
                <Tabs.Trigger
                  key={v}
                  value={v}
                  className="rounded-lg px-6 py-2.5 text-[14px] font-semibold capitalize text-text-muted transition-all data-[state=active]:bg-bg-card data-[state=active]:text-text-primary data-[state=active]:shadow-lg"
                >
                  {v === "trace" ? "Trace" : v === "eval" ? "Eval" : "Cost"}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          </div>

          {/* --- TRACE --- */}
          <Tabs.Content value="trace" className="mt-12 lg:mt-16" forceMount>
            <AnimatePresence mode="wait">
              {active === "trace" && (
            <motion.div
              key="trace"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
            <div className="grid items-start gap-10 lg:grid-cols-2 lg:gap-16">
              <div className="lg:py-4">
                <h3 className="font-display text-2xl font-bold text-text-primary md:text-3xl">
                  Every execution. Every tool call. Every token.
                </h3>
                <p className="mt-4 text-[16px] leading-relaxed text-text-secondary">
                  <code className="rounded-md border border-border-default bg-bg-surface px-2 py-0.5 font-mono text-[13px] text-text-accent">log_trace</code>{" "}
                  captures full agent runs with hierarchical spans, per-tool-call latency, token usage, and cost in USD.
                </p>
                <ul className="mt-8 space-y-4">
                  {["Hierarchical span tree with OpenTelemetry-compatible span kinds", "Per-tool-call latency tracking", "Token usage breakdown (prompt, completion, total)", "Arbitrary metadata for custom attribution"].map((t) => (
                    <li key={t} className="flex items-start gap-3 text-[15px] text-text-secondary">
                      <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-iris-500 shadow-[0_0_6px_var(--iris-500)]" />
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="card-premium overflow-hidden p-6">
                <div className="mb-4 text-[11px] font-bold uppercase tracking-[0.15em] text-text-muted">Span Tree</div>
                <div className="space-y-0.5 font-mono text-[13px]">
                  <div className="flex items-center gap-2 rounded-lg bg-iris-600/10 px-3 py-2">
                    <span className="text-[10px] font-bold text-iris-400">AGENT</span>
                    <span className="text-text-primary">research-agent</span>
                    <span className="ml-auto tabular-nums text-text-muted">2.3s</span>
                  </div>
                  {[
                    { t: "LLM", n: "system_prompt", d: "0.1s" },
                    { t: "TOOL", n: "web_search", d: "0.8s" },
                    { t: "LLM", n: "summarize_results", d: "0.4s" },
                    { t: "TOOL", n: "database_query", d: "0.3s" },
                    { t: "LLM", n: "final_response", d: "0.7s" },
                  ].map((r) => (
                    <div key={r.n} className="flex items-center gap-2 rounded-lg px-3 py-2 pl-8 transition-colors hover:bg-border-subtle">
                      <span className="text-text-muted select-none">├─</span>
                      <span className={`text-[10px] font-bold ${r.t === "TOOL" ? "text-eval-pass" : "text-text-accent"}`}>{r.t}</span>
                      <span className="text-text-primary">{r.n}</span>
                      <span className="ml-auto tabular-nums text-text-muted">{r.d}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            </motion.div>
              )}
            </AnimatePresence>
          </Tabs.Content>

          {/* --- EVAL --- */}
          <Tabs.Content value="eval" className="mt-12 lg:mt-16" forceMount>
            <AnimatePresence mode="wait">
              {active === "eval" && (
            <motion.div
              key="eval"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
            <div className="grid items-start gap-10 lg:grid-cols-2 lg:gap-16">
              <div className="lg:py-4">
                <h3 className="font-display text-2xl font-bold text-text-primary md:text-3xl">
                  13 built-in rules across 4 categories.
                </h3>
                <p className="mt-4 text-[16px] leading-relaxed text-text-secondary">
                  <code className="rounded-md border border-border-default bg-bg-surface px-2 py-0.5 font-mono text-[13px] text-text-accent">evaluate_output</code>{" "}
                  scores quality across completeness, relevance, safety, and cost with actionable suggestions.
                </p>
                <ul className="mt-8 space-y-4">
                  {["PII detection: SSN, credit card, phone, email patterns", "Prompt injection detection: 5 attack patterns", "Hallucination markers and topic consistency", "Custom rules with regex, keywords, JSON validation"].map((t) => (
                    <li key={t} className="flex items-start gap-3 text-[15px] text-text-secondary">
                      <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-iris-500 shadow-[0_0_6px_var(--iris-500)]" />
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="card-premium overflow-hidden p-6">
                <div className="mb-4 text-[11px] font-bold uppercase tracking-[0.15em] text-text-muted">Evaluation Results</div>
                <div className="space-y-3">
                  {EVAL_ROWS.map((r) => (
                    <div key={r.rule} className="flex items-center gap-3 text-[13px]">
                      <span className="w-[72px] shrink-0 font-mono text-[10px] font-bold text-text-muted">{r.cat}</span>
                      <span className="flex-1 text-text-primary">{r.rule}</span>
                      <Badge status={r.status} />
                      <span className="w-8 text-right font-mono tabular-nums text-text-muted">{r.score}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-5 flex items-center justify-end gap-3 border-t border-border-subtle pt-4">
                  <span className="text-[13px] text-text-muted">Weighted Score</span>
                  <span className="font-mono text-[15px] font-bold text-text-primary">0.71 / 1.0</span>
                </div>
              </div>
            </div>
            </motion.div>
              )}
            </AnimatePresence>
          </Tabs.Content>

          {/* --- COST --- */}
          <Tabs.Content value="cost" className="mt-12 lg:mt-16" forceMount>
            <AnimatePresence mode="wait">
              {active === "cost" && (
            <motion.div
              key="cost"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
            <div className="grid items-start gap-10 lg:grid-cols-2 lg:gap-16">
              <div className="lg:py-4">
                <h3 className="font-display text-2xl font-bold text-text-primary md:text-3xl">
                  See what your agents actually cost you.
                </h3>
                <p className="mt-4 text-[16px] leading-relaxed text-text-secondary">
                  Aggregate cost across all agents over any time window. Not just per-trace cost — total spend visibility.
                </p>
                <ul className="mt-8 space-y-4">
                  {["Per-execution cost in USD with token breakdown", "Aggregate cost by agent, by time window", "Budget threshold enforcement via eval rules", "Token efficiency ratio monitoring"].map((t) => (
                    <li key={t} className="flex items-start gap-3 text-[15px] text-text-secondary">
                      <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-iris-500 shadow-[0_0_6px_var(--iris-500)]" />
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="card-premium overflow-hidden p-6">
                <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.15em] text-text-muted">Cost Overview — Last 7 Days</div>
                <p className="mb-5 text-[10px] italic text-text-muted">Example data</p>
                <div className="mb-6 flex gap-8">
                  {[
                    { label: "Total Spend", value: "$127.43" },
                    { label: "Avg / Trace", value: "$0.07" },
                    { label: "Over Budget", value: "23", accent: true },
                  ].map((s) => (
                    <div key={s.label}>
                      <div className="text-[11px] text-text-muted">{s.label}</div>
                      <div className={`font-mono text-2xl font-bold ${s.accent ? "text-eval-warn" : "text-text-primary"}`}>{s.value}</div>
                    </div>
                  ))}
                </div>
                <div className="space-y-4">
                  {COST_AGENTS.map((a) => (
                    <div key={a.name}>
                      <div className="mb-1.5 flex items-center justify-between text-[13px]">
                        <span className="font-mono text-text-primary">{a.name}</span>
                        <span className="font-mono text-text-muted">{a.cost}</span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-border-subtle">
                        <div className="h-2 rounded-full bg-gradient-to-r from-iris-600 to-iris-400" style={{ width: `${a.pct}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            </motion.div>
              )}
            </AnimatePresence>
          </Tabs.Content>
        </Tabs.Root>
      </div>
    </section>
  );
}
