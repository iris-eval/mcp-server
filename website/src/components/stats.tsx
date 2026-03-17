"use client";

import { AnimatedCounter } from "./animated-counter";

const STATS = [
  { value: 3, suffix: "", label: "MCP tools", detail: "log_trace, evaluate_output, get_traces" },
  { value: 12, suffix: "", label: "Built-in eval rules", detail: "Completeness, relevance, safety, cost" },
  { prefix: "<", value: 1, suffix: "ms", label: "Eval latency", detail: "Heuristic rules. Fast and deterministic." },
  { value: 0, suffix: "", label: "Lines of code to integrate", detail: "Add to MCP config. You're done.", static: true },
];

export function Stats(): React.ReactElement {
  return (
    <section className="relative overflow-hidden border-y border-border-subtle py-20 lg:py-28">
      <div className="glow-hero absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-20" aria-hidden="true" />
      <div className="relative mx-auto max-w-7xl px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-y-12 gap-x-8 md:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.label} className="text-center">
              <div className="font-display text-5xl font-extrabold tracking-tight text-text-primary md:text-6xl">
                {s.static ? (
                  <>{s.value}</>
                ) : (
                  <AnimatedCounter
                    value={s.value}
                    prefix={s.prefix}
                    suffix={s.suffix}
                  />
                )}
              </div>
              <div className="mt-2 text-[14px] font-semibold text-text-accent">
                {s.label}
              </div>
              <div className="mt-1 text-[13px] text-text-muted">
                {s.detail}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
