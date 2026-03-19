"use client";

import { motion, useReducedMotion } from "framer-motion";

interface EvalScoreGaugeProps {
  score: number;
  size?: number;
  delay?: number;
}

const ARC_START = -210;
const ARC_SPAN = 240;

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
}

function scoreColor(score: number): string {
  if (score >= 0.7) return "var(--eval-pass)";
  if (score >= 0.4) return "var(--eval-warn)";
  return "var(--eval-fail)";
}

export function EvalScoreGauge({ score, size = 120, delay = 0 }: EvalScoreGaugeProps) {
  const reduce = useReducedMotion();
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 10;
  const strokeWidth = 8;

  const bgPath = describeArc(cx, cy, r, ARC_START, ARC_START + ARC_SPAN);
  const fillAngle = ARC_START + ARC_SPAN * score;
  const fillPath = describeArc(cx, cy, r, ARC_START, fillAngle);

  const color = scoreColor(score);

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Background arc */}
        <path
          d={bgPath}
          fill="none"
          stroke="var(--border-subtle)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
        {/* Filled arc */}
        <motion.path
          d={fillPath}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          initial={reduce ? {} : { pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{
            pathLength: { duration: 0.8, ease: [0.22, 1, 0.36, 1], delay },
            opacity: { duration: 0.2, delay },
          }}
        />
      </svg>
      {/* Center text */}
      <motion.div
        className="absolute inset-0 flex flex-col items-center justify-center"
        initial={reduce ? {} : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: delay + 0.6, duration: 0.3 }}
      >
        <span className="font-mono text-2xl font-bold" style={{ color }}>
          {score.toFixed(2)}
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          Score
        </span>
      </motion.div>
    </div>
  );
}
