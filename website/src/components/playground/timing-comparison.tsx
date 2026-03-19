"use client";

import { useEffect, useState, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";

interface TimingComparisonProps {
  humanSeconds: number;
}

export function TimingComparison({ humanSeconds }: TimingComparisonProps) {
  const reduce = useReducedMotion();
  const [humanDisplay, setHumanDisplay] = useState(0);
  const [humanDone, setHumanDone] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    if (reduce) {
      setHumanDisplay(humanSeconds);
      setHumanDone(true);
      return;
    }

    let start: number | null = null;
    const duration = 1500; // 1.5s to count up

    const step = (ts: number): void => {
      if (!start) start = ts;
      const progress = Math.min((ts - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setHumanDisplay(Math.round(eased * humanSeconds));
      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        setHumanDone(true);
      }
    };
    requestAnimationFrame(step);
  }, [humanSeconds, reduce]);

  const speedMultiplier = Math.round(humanSeconds / 0.003);

  return (
    <div className="mt-4 rounded-xl border border-border-subtle bg-bg-surface p-5">
      <div className="flex flex-col items-center gap-6 sm:flex-row sm:justify-center sm:gap-12">
        {/* Human side */}
        <div className="text-center">
          <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Human Reviewer
          </div>
          <div className="mt-2 font-mono text-3xl font-bold tabular-nums text-text-primary">
            {humanDisplay}
            <span className="text-lg text-text-muted">s</span>
          </div>
          <div className="mt-1 text-[12px] text-text-muted">Manual review</div>
        </div>

        {/* VS divider */}
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-bg-card text-[11px] font-bold text-text-muted">
          vs
        </div>

        {/* Iris side */}
        <div className="text-center">
          <div className="text-[11px] font-bold uppercase tracking-wider text-text-accent">
            Iris
          </div>
          <motion.div
            className="mt-2 font-mono text-3xl font-bold tabular-nums text-text-accent"
            initial={reduce ? {} : { opacity: 0, scale: 0.5 }}
            animate={humanDone ? { opacity: 1, scale: 1 } : {}}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            style={!humanDone && !reduce ? { opacity: 0 } : undefined}
          >
            0.003
            <span className="text-lg text-text-muted">s</span>
          </motion.div>
          <div className="mt-1 text-[12px] text-text-muted">Automated eval</div>
        </div>
      </div>

      {/* Speed comparison */}
      <motion.div
        className="mt-4 text-center text-[13px] font-medium text-text-secondary"
        initial={reduce ? {} : { opacity: 0 }}
        animate={humanDone ? { opacity: 1 } : {}}
        transition={{ delay: 0.3, duration: 0.3 }}
        style={!humanDone && !reduce ? { opacity: 0 } : undefined}
      >
        <span className="text-text-accent font-bold">{speedMultiplier.toLocaleString()}x</span> faster — every time, at any scale
      </motion.div>
    </div>
  );
}
