"use client";

import { motion, useReducedMotion } from "framer-motion";
import { EvalScoreGauge } from "./eval-score-gauge";
import { TrendChartSvg } from "./trend-chart-svg";
import { RuleBreakdownBars } from "./rule-breakdown-bars";
import {
  DASHBOARD_STATS,
  TREND_DATA,
  RULE_BREAKDOWN,
  RECENT_FAILURES,
} from "./playground-data";

const EASE = [0.22, 1, 0.36, 1] as const;

const STATUS_STYLE: Record<string, string> = {
  pass: "bg-eval-pass/10 text-eval-pass",
  warn: "bg-eval-warn/10 text-eval-warn",
  fail: "bg-eval-fail/10 text-eval-fail",
};

function StatCard({
  label,
  value,
  sub,
  color,
  delay,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  delay: number;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className="rounded-lg border border-border-subtle bg-bg-surface p-4"
      initial={reduce ? {} : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.3, ease: EASE }}
    >
      <div className="text-[11px] font-medium text-text-muted">{label}</div>
      <div
        className="mt-1 font-mono text-xl font-bold"
        style={{ color: color ?? "var(--text-primary)" }}
      >
        {value}
      </div>
      {sub && (
        <div className="mt-0.5 text-[11px] text-text-muted">{sub}</div>
      )}
    </motion.div>
  );
}

export function ActThree() {
  const reduce = useReducedMotion();

  const safetyTotal =
    DASHBOARD_STATS.safetyViolations.pii +
    DASHBOARD_STATS.safetyViolations.injection +
    DASHBOARD_STATS.safetyViolations.hallucination;

  return (
    <section className="border-t border-border-subtle py-20 lg:py-28">
      <div className="mx-auto max-w-6xl px-6 lg:px-8">
        {/* Section header */}
        <motion.div
          className="text-center"
          initial={reduce ? {} : { opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE }}
        >
          <span className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-bg-surface px-4 py-1.5 text-[12px] font-semibold text-text-accent">
            Act 3
          </span>
          <h2 className="mt-4 font-display text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
            Your Eval <span className="text-gradient">Dashboard</span>
          </h2>
          <p className="mt-3 text-text-secondary">
            This is what Iris looks like in production. Explore the dashboard with real-shaped data.
          </p>
          <p className="mt-1 text-[12px] text-text-muted md:hidden">
            Best viewed on desktop for the full dashboard experience.
          </p>
        </motion.div>

        {/* Dashboard frame */}
        <div className="mt-10">
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
                <span>
                  Agents:{" "}
                  <span className="font-semibold text-text-secondary">
                    {DASHBOARD_STATS.agentCount}
                  </span>
                </span>
                <span>
                  Evals:{" "}
                  <span className="font-semibold text-text-secondary">
                    {DASHBOARD_STATS.totalEvals.toLocaleString()}
                  </span>
                </span>
              </div>
            </div>

            {/* Dashboard content */}
            <div className="p-4 md:p-6">
              {/* Top row: Gauge + Stats */}
              <div className="flex flex-col items-center gap-6 md:flex-row md:items-start">
                {/* Gauge */}
                <div className="shrink-0">
                  <div className="rounded-xl border border-border-subtle bg-bg-surface p-6 text-center">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted mb-2">
                      Overall Score
                    </div>
                    <EvalScoreGauge
                      score={DASHBOARD_STATS.avgScore}
                      size={140}
                      delay={0}
                    />
                    <div className="mt-2 text-[12px] text-text-secondary">
                      {Math.round(DASHBOARD_STATS.passRate * 100)}% pass rate
                    </div>
                  </div>
                </div>

                {/* Stat cards */}
                <div className="grid flex-1 grid-cols-2 gap-3 lg:grid-cols-3">
                  <StatCard
                    label="Total Evals"
                    value={DASHBOARD_STATS.totalEvals.toLocaleString()}
                    sub="Last 7 days"
                    delay={0.2}
                  />
                  <StatCard
                    label="Avg Score"
                    value={DASHBOARD_STATS.avgScore.toFixed(2)}
                    sub="+0.03 from last week"
                    color="var(--eval-pass)"
                    delay={0.3}
                  />
                  <StatCard
                    label="Total Cost"
                    value={`$${DASHBOARD_STATS.totalCost.toFixed(2)}`}
                    sub="$18.20/day avg"
                    color="var(--eval-warn)"
                    delay={0.4}
                  />
                  <StatCard
                    label="Safety Violations"
                    value={String(safetyTotal)}
                    sub={`${DASHBOARD_STATS.safetyViolations.pii} PII · ${DASHBOARD_STATS.safetyViolations.injection} injection · ${DASHBOARD_STATS.safetyViolations.hallucination} hallucination`}
                    color="var(--eval-fail)"
                    delay={0.5}
                  />
                  <StatCard
                    label="Pass Rate"
                    value={`${Math.round(DASHBOARD_STATS.passRate * 100)}%`}
                    sub="87% of evals pass"
                    color="var(--eval-pass)"
                    delay={0.6}
                  />
                  <StatCard
                    label="Active Agents"
                    value={String(DASHBOARD_STATS.agentCount)}
                    sub="Across all environments"
                    delay={0.7}
                  />
                </div>
              </div>

              {/* Middle row: Trend + Rule breakdown */}
              <div className="mt-6 grid gap-6 lg:grid-cols-2">
                {/* Trend chart */}
                <motion.div
                  className="rounded-xl border border-border-subtle bg-bg-surface p-5"
                  initial={reduce ? {} : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.4, duration: 0.3 }}
                >
                  <div className="mb-4 flex items-center justify-between">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
                      Score Trend (7 days)
                    </span>
                    <span className="text-[10px] text-text-muted">
                      Dip on Wed-Thu: agent config change
                    </span>
                  </div>
                  <TrendChartSvg data={TREND_DATA} delay={0.4} />
                </motion.div>

                {/* Rule breakdown */}
                <motion.div
                  className="rounded-xl border border-border-subtle bg-bg-surface p-5"
                  initial={reduce ? {} : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.6, duration: 0.3 }}
                >
                  <div className="mb-4">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
                      Rule Pass Rates
                    </span>
                  </div>
                  <RuleBreakdownBars data={RULE_BREAKDOWN} delay={0.8} />
                </motion.div>
              </div>

              {/* Bottom: Failures table */}
              <motion.div
                className="mt-6 rounded-xl border border-border-subtle"
                initial={reduce ? {} : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.8, duration: 0.3 }}
              >
                <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
                    Recent Failures
                  </span>
                  <span className="text-[10px] text-text-muted">
                    {RECENT_FAILURES.length} failures
                  </span>
                </div>
                {/* Table header */}
                <div className="hidden border-b border-border-subtle bg-bg-surface px-5 py-2 md:flex">
                  {["Agent", "Failed Rule", "Score", "When"].map((h) => (
                    <span
                      key={h}
                      className="flex-1 text-[10px] font-bold uppercase tracking-wider text-text-muted"
                    >
                      {h}
                    </span>
                  ))}
                </div>
                {/* Rows */}
                {RECENT_FAILURES.map((f, i) => (
                  <motion.div
                    key={`${f.agent}-${f.rule}`}
                    className="flex flex-col gap-1 border-b border-border-subtle px-5 py-2.5 last:border-0 md:flex-row md:items-center md:gap-0"
                    initial={reduce ? {} : { opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 1.0 + i * 0.06, duration: 0.2 }}
                  >
                    <span className="flex-1 font-mono text-[12px] font-medium text-text-primary">
                      {f.agent}
                    </span>
                    <span className="flex-1">
                      <span className={`inline-flex rounded-md px-2 py-0.5 font-mono text-[10px] font-bold ${STATUS_STYLE.fail}`}>
                        {f.rule.replace(/_/g, " ")}
                      </span>
                    </span>
                    <span className="flex-1 font-mono text-[12px] tabular-nums text-eval-fail">
                      {f.score.toFixed(2)}
                    </span>
                    <span className="flex-1 text-[12px] text-text-muted">
                      {f.timestamp}
                    </span>
                  </motion.div>
                ))}
              </motion.div>

              {/* Cloud tier seed */}
              <motion.div
                className="mt-4 text-center"
                initial={reduce ? {} : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 1.4, duration: 0.3 }}
              >
                <p className="text-[12px] text-text-muted">
                  Want to share eval results with your team?{" "}
                  <a
                    href="/#pricing"
                    className="text-text-accent transition-colors hover:text-iris-300"
                  >
                    Cloud team dashboards coming soon →
                  </a>
                </p>
              </motion.div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
