"use client";

import { motion, useReducedMotion } from "framer-motion";
import { EvalScoreGauge } from "./eval-score-gauge";
import type { RuleResult } from "./playground-data";

interface EvalRevealProps {
  score: number;
  verdict: "PASS" | "FAIL";
  rules: RuleResult[];
  failedRule: string;
  lesson: string;
  delay?: number;
}

const EASE = [0.22, 1, 0.36, 1] as const;

function ruleDisplayName(name: string): string {
  return name.replace(/_/g, " ").replace(/\bno\b/g, "no").replace(/\bpii\b/gi, "PII");
}

export function EvalReveal({ score, verdict, rules, failedRule, lesson, delay = 0 }: EvalRevealProps) {
  const reduce = useReducedMotion();

  return (
    <motion.div
      className="rounded-xl border border-border-subtle bg-bg-card overflow-hidden"
      initial={reduce ? {} : { opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: EASE, delay }}
    >
      {/* Header */}
      <div className="border-b border-border-subtle bg-bg-surface px-5 py-3">
        <span className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
          Iris Eval Results
        </span>
      </div>

      <div className="flex flex-col items-center gap-6 px-5 py-6 md:flex-row md:items-start">
        {/* Gauge */}
        <div className="shrink-0">
          <EvalScoreGauge score={score} size={120} delay={delay + 0.4} />
        </div>

        {/* Rule breakdown */}
        <div className="flex-1 w-full">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
            {rules.map((rule, i) => (
              <motion.div
                key={rule.name}
                className="flex items-center gap-2"
                initial={reduce ? {} : { opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: delay + 0.2 + i * 0.06, duration: 0.2 }}
              >
                <span
                  className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                    rule.pass ? "bg-eval-pass" : "bg-eval-fail"
                  }`}
                />
                <span
                  className={`text-[11px] ${
                    rule.name === failedRule
                      ? "font-bold text-eval-fail"
                      : "text-text-muted"
                  }`}
                >
                  {ruleDisplayName(rule.name)}
                </span>
                <span
                  className={`ml-auto font-mono text-[11px] tabular-nums ${
                    rule.pass ? "text-eval-pass" : "text-eval-fail"
                  }`}
                >
                  {rule.score.toFixed(1)}
                </span>
              </motion.div>
            ))}
          </div>
        </div>
      </div>

      {/* Verdict + lesson */}
      <motion.div
        className="border-t border-border-subtle px-5 py-4"
        initial={reduce ? {} : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: delay + 1.2, duration: 0.3 }}
      >
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex rounded-md px-3 py-1 font-mono text-[12px] font-bold ${
              verdict === "PASS"
                ? "bg-eval-pass/10 text-eval-pass"
                : "bg-eval-fail/10 text-eval-fail"
            }`}
          >
            {verdict}
          </span>
          <p className="text-[13px] leading-relaxed text-text-secondary">{lesson}</p>
        </div>
      </motion.div>
    </motion.div>
  );
}
