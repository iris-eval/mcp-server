"use client";

import { motion, useReducedMotion, useInView } from "framer-motion";
import { useRef } from "react";

const APM_ROWS = [
  { label: "Status", value: "200 OK", color: "text-eval-pass" },
  { label: "Latency", value: "143ms" },
  { label: "Memory", value: "245 MB" },
  { label: "CPU", value: "12%" },
  { label: "Throughput", value: "847 req/min" },
  { label: "Health", value: "All systems operational", color: "text-eval-pass" },
];

const IRIS_ROWS = [
  { label: "PII Detected", detail: "SSN pattern in output (***-**-6789)", dot: "bg-eval-fail" },
  { label: "Injection Risk", detail: "Prompt manipulation attempt detected", dot: "bg-eval-warn" },
  { label: "Cost: $0.47 / query", detail: "4.7x over $0.10 threshold", dot: "bg-eval-warn" },
  { label: "Hallucination Markers", detail: '"As an AI language model" in output', dot: "bg-eval-fail" },
  { label: "Tool call #3 error", detail: "database_lookup timed out (30s)", dot: "bg-eval-fail" },
  { label: "Quality Score", detail: "0.32 / 1.0 — FAIL", dot: "bg-eval-fail" },
];

export function Problem(): React.ReactElement {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });
  const reduce = useReducedMotion();

  return (
    <section ref={ref} className="relative py-32 lg:py-44" id="problem">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <motion.div
            initial={reduce ? {} : { opacity: 0, y: 20 }}
            animate={inView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.5 }}
          >
            <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">
              The Problem
            </p>
            <h2 className="mt-4 font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl lg:text-6xl">
              Your agents pass every{" "}
              <span className="text-gradient">health check.</span>
            </h2>
            <p className="mt-6 text-lg leading-relaxed text-text-secondary md:text-xl">
              Infrastructure monitoring tells you the request succeeded. It
              cannot tell you the answer was wrong. Your agents need a quality
              gate — something that scores every output for safety, accuracy,
              and cost before it reaches a user.
            </p>
          </motion.div>
        </div>

        <div className="mt-16 grid gap-6 lg:mt-20 lg:grid-cols-2 lg:gap-8">
          {/* APM card */}
          <motion.div
            initial={reduce ? {} : { opacity: 0, y: 16 }}
            animate={inView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.4, delay: 0.1 }}
            className="card-premium overflow-hidden p-8"
          >
            <div className="mb-6 flex items-center gap-2">
              <div className="h-2.5 w-2.5 rounded-full bg-text-muted" />
              <span className="text-[13px] font-semibold uppercase tracking-wider text-text-muted">
                What your APM sees
              </span>
            </div>
            <div className="space-y-4">
              {APM_ROWS.map((row) => (
                <div key={row.label} className="flex items-center justify-between border-b border-border-subtle pb-3 last:border-0 last:pb-0">
                  <span className="text-[14px] text-text-muted">{row.label}</span>
                  <span className={`font-mono text-[14px] font-medium ${row.color ?? "text-text-secondary"}`}>{row.value}</span>
                </div>
              ))}
            </div>
          </motion.div>

          {/* Iris card — glowing border */}
          <motion.div
            initial={reduce ? {} : { opacity: 0, y: 16 }}
            animate={inView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.4, delay: 0.2 }}
            className="relative overflow-hidden rounded-2xl p-8"
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border-glow)",
              boxShadow: "0 0 60px var(--glow-iris), inset 0 1px 0 rgba(255,255,255,0.05)",
            }}
          >
            <div className="mb-6 flex items-center gap-2">
              <div className="pulse-dot h-2.5 w-2.5 rounded-full bg-iris-500" />
              <span className="text-[13px] font-semibold uppercase tracking-wider text-text-accent">
                What Iris sees
              </span>
            </div>
            <div className="space-y-4">
              {IRIS_ROWS.map((row) => (
                <div key={row.label} className="flex items-start gap-3 border-b border-border-subtle pb-3 last:border-0 last:pb-0">
                  <span className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${row.dot}`} />
                  <div>
                    <div className="text-[14px] font-semibold text-text-primary">{row.label}</div>
                    <div className="mt-0.5 text-[13px] text-text-muted">{row.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
