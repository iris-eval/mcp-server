"use client";

import { motion, useReducedMotion } from "framer-motion";

const TRACES = [
  { agent: "research-agent", status: "pass", score: "0.94", cost: "$0.12", latency: "2.3s", tools: 5 },
  { agent: "code-review-bot", status: "pass", score: "0.87", cost: "$0.04", latency: "1.1s", tools: 3 },
  { agent: "support-agent", status: "fail", score: "0.32", cost: "$0.47", latency: "4.8s", tools: 7 },
  { agent: "data-pipeline", status: "pass", score: "0.91", cost: "$0.08", latency: "0.6s", tools: 2 },
  { agent: "content-writer", status: "warn", score: "0.62", cost: "$0.21", latency: "3.4s", tools: 4 },
];

const STATUS_STYLE: Record<string, string> = {
  pass: "bg-eval-pass/10 text-eval-pass",
  warn: "bg-eval-warn/10 text-eval-warn",
  fail: "bg-eval-fail/10 text-eval-fail",
};

export function DashboardMockup(): React.ReactElement {
  const reduce = useReducedMotion();

  return (
    <div className="window-frame relative shadow-2xl shadow-black/30">
      {/* Window bar */}
      <div className="window-bar">
        <span className="window-dot bg-[#ff5f57]" />
        <span className="window-dot bg-[#febc2e]" />
        <span className="window-dot bg-[#28c840]" />
        <span className="ml-3 font-mono text-[12px] text-text-muted">
          Iris Dashboard — localhost:3838
        </span>
        <div className="ml-auto flex items-center gap-4 text-[11px] text-text-muted">
          <span>Agents: <span className="font-semibold text-text-secondary">5</span></span>
          <span>Traces: <span className="font-semibold text-text-secondary">1,247</span></span>
          <span>Cost (7d): <span className="font-semibold text-eval-warn">$127.43</span></span>
        </div>
      </div>

      {/* Dashboard content */}
      <div className="p-4 md:p-6">
        {/* Top stats row */}
        <div className="mb-6 grid grid-cols-4 gap-3">
          {[
            { label: "Total Traces", value: "1,247", change: "+12%", up: true },
            { label: "Avg Score", value: "0.84", change: "+0.03", up: true },
            { label: "Total Cost", value: "$127.43", change: "+8%", up: false },
            { label: "PII Alerts", value: "3", change: "-2", up: true },
          ].map((s, i) => (
            <motion.div
              key={s.label}
              initial={reduce ? {} : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5 + i * 0.08, duration: 0.3 }}
              className="rounded-lg border border-border-subtle bg-bg-surface p-3"
            >
              <div className="text-[10px] font-medium text-text-muted">{s.label}</div>
              <div className="mt-1 font-mono text-lg font-bold text-text-primary md:text-xl">{s.value}</div>
              <div className={`mt-0.5 text-[10px] font-semibold ${s.up ? "text-eval-pass" : "text-eval-fail"}`}>
                {s.change}
              </div>
            </motion.div>
          ))}
        </div>

        {/* Traces table */}
        <div className="rounded-lg border border-border-subtle">
          <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
            <span className="text-[11px] font-bold uppercase tracking-wider text-text-muted">Recent Traces</span>
            <span className="text-[10px] text-text-muted">Last 24 hours</span>
          </div>
          <div className="overflow-hidden">
            {/* Header */}
            <div className="hidden border-b border-border-subtle bg-bg-surface px-4 py-2 md:flex">
              {["Agent", "Status", "Score", "Cost", "Latency", "Tools"].map((h) => (
                <span key={h} className="flex-1 text-[10px] font-bold uppercase tracking-wider text-text-muted">{h}</span>
              ))}
            </div>
            {/* Rows */}
            {TRACES.map((t, i) => (
              <motion.div
                key={t.agent}
                initial={reduce ? {} : { opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.7 + i * 0.06, duration: 0.25 }}
                className="flex items-center border-b border-border-subtle px-4 py-2.5 transition-colors last:border-0 hover:bg-bg-surface/50"
              >
                <span className="flex-1 font-mono text-[12px] font-medium text-text-primary">{t.agent}</span>
                <span className="flex-1">
                  <span className={`inline-flex rounded-md px-2 py-0.5 font-mono text-[10px] font-bold uppercase ${STATUS_STYLE[t.status]}`}>
                    {t.status}
                  </span>
                </span>
                <span className="flex-1 font-mono text-[12px] text-text-secondary tabular-nums">{t.score}</span>
                <span className="flex-1 font-mono text-[12px] text-text-secondary tabular-nums">{t.cost}</span>
                <span className="flex-1 font-mono text-[12px] text-text-secondary tabular-nums">{t.latency}</span>
                <span className="flex-1 font-mono text-[12px] text-text-secondary tabular-nums">{t.tools}</span>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
