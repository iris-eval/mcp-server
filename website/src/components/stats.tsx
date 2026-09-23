"use client";

import { AnimatedCounter } from "./animated-counter";
import { MCP_TOOL_COUNT, PROOF, RULE_COUNT_BUILT_IN } from "@/lib/claims";

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
  // The median the proof measured, never a literal: "<1ms" stood here while
  // /proof measured 8.8 ms (2026-09-23 review).
  ...(PROOF?.latency
    ? [{ prefix: "~", value: Math.max(1, Math.round(PROOF.latency.p50Ms)), suffix: "ms", label: "Median eval latency", detail: "Every built-in rule, measured on the proof corpus. Deterministic, no model call.", static: true }]
    : []),
  { value: 1, suffix: "", label: "Config block to connect", detail: "Your client lists Iris's tools on connect. Your agent, a host hook or the CLI hands it the runs to score.", static: true },
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
