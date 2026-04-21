"use client";

import { motion, useReducedMotion } from "framer-motion";

const EASE = [0.22, 1, 0.36, 1] as const;

interface CompletedActPillProps {
  actNumber: 1 | 2;
  title: string;
  summary: string;
  accent: "pass" | "warn" | "neutral";
}

export function CompletedActPill({ actNumber, title, summary, accent }: CompletedActPillProps) {
  const reduce = useReducedMotion();

  const accentClasses = {
    pass: "border-eval-pass/30 bg-eval-pass/5",
    warn: "border-eval-warn/30 bg-eval-warn/5",
    neutral: "border-border-subtle bg-bg-surface",
  }[accent];

  const badgeClasses = {
    pass: "bg-eval-pass/10 text-eval-pass",
    warn: "bg-eval-warn/10 text-eval-warn",
    neutral: "bg-bg-card text-text-muted",
  }[accent];

  return (
    <motion.div
      layout
      initial={reduce ? {} : { opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      transition={{ duration: 0.4, ease: EASE }}
      className="py-4"
    >
      <div className="mx-auto max-w-4xl px-6 lg:px-8">
        <div
          className={`flex items-center gap-4 rounded-xl border px-5 py-3 ${accentClasses}`}
          aria-label={`Act ${actNumber} complete: ${summary}`}
        >
          <span className={`inline-flex shrink-0 items-center rounded-md px-2.5 py-1 font-mono text-[11px] font-bold ${badgeClasses}`}>
            Act {actNumber} ✓
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold text-text-primary">{title}</p>
            <p className="truncate text-[12px] text-text-secondary">{summary}</p>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
