"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { RuleBreakdown } from "./playground-data";

interface RuleBreakdownBarsProps {
  data: RuleBreakdown[];
  delay?: number;
}

function barColor(rate: number): string {
  if (rate >= 0.9) return "bg-eval-pass";
  if (rate >= 0.8) return "bg-eval-warn";
  return "bg-eval-fail";
}

function displayName(rule: string): string {
  return rule.replace(/_/g, " ").replace(/\bpii\b/gi, "PII");
}

export function RuleBreakdownBars({ data, delay = 0 }: RuleBreakdownBarsProps) {
  const reduce = useReducedMotion();

  return (
    <div className="space-y-2.5">
      {data.map((item, i) => (
        <motion.div
          key={item.rule}
          className="flex items-center gap-3"
          initial={reduce ? {} : { opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: delay + i * 0.05, duration: 0.25 }}
        >
          <span className="w-40 shrink-0 text-[11px] text-text-muted truncate">
            {displayName(item.rule)}
          </span>
          <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-bg-surface">
            <motion.div
              className={`absolute inset-y-0 left-0 rounded-full ${barColor(item.passRate)}`}
              initial={reduce ? { width: `${item.passRate * 100}%` } : { width: 0 }}
              animate={{ width: `${item.passRate * 100}%` }}
              transition={{ duration: 0.6, delay: delay + 0.3 + i * 0.05, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
          <span className="w-10 text-right font-mono text-[11px] tabular-nums text-text-secondary">
            {Math.round(item.passRate * 100)}%
          </span>
        </motion.div>
      ))}
    </div>
  );
}
