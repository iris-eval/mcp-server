"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { Highlight } from "./playground-data";

interface ScenarioOutputProps {
  prompt: string;
  output: string;
  highlights: Highlight[];
  showHighlights: boolean;
  costIndicator?: { actual: string; threshold: string };
}

function renderHighlightedText(text: string, highlights: Highlight[], show: boolean) {
  if (!show || highlights.length === 0) {
    return <span>{text}</span>;
  }

  const sorted = [...highlights].sort((a, b) => a.startIndex - b.startIndex);
  const parts: React.ReactNode[] = [];
  let cursor = 0;

  sorted.forEach((h, i) => {
    const idx = text.indexOf(h.text, cursor);
    if (idx === -1) return;
    if (idx > cursor) {
      parts.push(<span key={`t-${i}`}>{text.slice(cursor, idx)}</span>);
    }
    parts.push(
      <motion.mark
        key={`h-${i}`}
        className="rounded bg-eval-fail/20 px-0.5 text-eval-fail"
        initial={{ opacity: 0, backgroundColor: "rgba(239,68,68,0)" }}
        animate={{ opacity: 1, backgroundColor: "rgba(239,68,68,0.2)" }}
        transition={{ duration: 0.3, delay: 0.6 }}
      >
        {h.text}
      </motion.mark>,
    );
    cursor = idx + h.text.length;
  });

  if (cursor < text.length) {
    parts.push(<span key="tail">{text.slice(cursor)}</span>);
  }

  return <>{parts}</>;
}

export function ScenarioOutput({
  prompt,
  output,
  highlights,
  showHighlights,
  costIndicator,
}: ScenarioOutputProps) {
  const reduce = useReducedMotion();

  return (
    <div className="rounded-xl border border-border-subtle bg-bg-card">
      {/* Prompt header */}
      <div className="border-b border-border-subtle px-5 py-3">
        <span className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
          Prompt
        </span>
        <p className="mt-1 text-sm text-text-primary">{prompt}</p>
      </div>

      {/* Agent output */}
      <div className="px-5 py-4">
        <span className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
          Agent Output
        </span>
        <div className="mt-2 whitespace-pre-wrap font-mono text-[13px] leading-relaxed text-text-secondary">
          {renderHighlightedText(output, highlights, showHighlights)}
        </div>
      </div>

      {/* Cost indicator (scenario 4) */}
      {costIndicator && showHighlights && (
        <motion.div
          className="border-t border-border-subtle px-5 py-3"
          initial={reduce ? {} : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4, duration: 0.3 }}
        >
          <div className="flex items-center gap-3">
            <span className="rounded-md bg-eval-fail/10 px-2 py-1 font-mono text-sm font-bold text-eval-fail">
              Cost: {costIndicator.actual}
            </span>
            <span className="text-[12px] text-text-muted">
              Threshold: {costIndicator.threshold}
            </span>
            <span className="font-mono text-[12px] font-semibold text-eval-fail">
              4.7× over budget
            </span>
          </div>
        </motion.div>
      )}
    </div>
  );
}
