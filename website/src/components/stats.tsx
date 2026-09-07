"use client";

import { AnimatedCounter } from "./animated-counter";
import { MCP_TOOL_COUNT, RULE_COUNT_BUILT_IN } from "@/lib/claims";

/*
 * BOTH COUNTS COME FROM THE TRUTHBASE, and the reason is written here
 * because the shape of this file is what defeated the guard.
 *
 * The scanner that catches a stale rule count written out in prose matches a
 * NUMBER ADJACENT TO ITS NOUN. Here the number and the noun live in
 * different fields of the same object — `value: 13` and
 * `label: "Built-in eval rules"` — so no adjacency pattern can pair them,
 * and this band sat on the homepage three releases out of date while the
 * scanner reported green and the roster had grown to 20.
 *
 * A literal here is therefore not a small shortcut; it is a number in the
 * one place the guard structurally cannot read. Do not reintroduce one.
 */
const STATS = [
  { value: MCP_TOOL_COUNT, suffix: "", label: "MCP tools", detail: "Log, evaluate, query, deploy/delete rules, delete traces, LLM judge (BYOK), citation verify (BYOK)", static: true },
  { value: RULE_COUNT_BUILT_IN, suffix: "", label: "Built-in eval rules", detail: "Completeness, relevance, safety, cost", static: true },
  { prefix: "<", value: 1, suffix: "ms", label: "Eval latency", detail: "Heuristic rules. Fast and deterministic.", static: true },
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
