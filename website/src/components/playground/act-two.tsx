"use client";

import { useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { EvalScoreGauge } from "./eval-score-gauge";
import { COMPARISON } from "./playground-data";
import type { AgentOutput } from "./playground-data";

const EASE = [0.22, 1, 0.36, 1] as const;

function AgentCard({
  agent,
  side,
  chosen,
  revealed,
  onClick,
}: {
  agent: AgentOutput;
  side: "A" | "B";
  chosen: "A" | "B" | null;
  revealed: boolean;
  onClick: () => void;
}) {
  const reduce = useReducedMotion();
  const isChosen = chosen === side;
  const isCorrect = side === COMPARISON.correctChoice;

  let borderClass = "border-border-subtle";
  if (revealed) {
    borderClass = isCorrect
      ? "border-eval-pass/50 shadow-eval-pass/5 shadow-lg"
      : "border-eval-fail/50 shadow-eval-fail/5 shadow-lg";
  } else if (isChosen) {
    borderClass = "border-iris-500/50";
  }

  return (
    <div
      className={`rounded-xl border bg-bg-card transition-all duration-300 ${borderClass} ${
        !revealed ? "cursor-pointer hover:border-iris-500/30" : ""
      }`}
      onClick={!revealed ? onClick : undefined}
      role={!revealed ? "button" : undefined}
      aria-label={!revealed ? `Choose ${agent.label}` : undefined}
      tabIndex={!revealed ? 0 : undefined}
      onKeyDown={!revealed ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
        <span className="font-mono text-[13px] font-bold text-text-primary">
          {agent.label}
        </span>
        {revealed && (
          <motion.span
            className={`inline-flex rounded-md px-2.5 py-1 font-mono text-[11px] font-bold ${
              agent.verdict === "PASS"
                ? "bg-eval-pass/10 text-eval-pass"
                : "bg-eval-fail/10 text-eval-fail"
            }`}
            initial={reduce ? {} : { opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.3, delay: 0.2 }}
          >
            {agent.verdict}
          </motion.span>
        )}
      </div>

      {/* Output */}
      <div className="px-5 py-4">
        <div className="whitespace-pre-wrap font-mono text-[13px] leading-relaxed text-text-secondary">
          {agent.output}
        </div>
      </div>

      {/* Score reveal */}
      {revealed && (
        <motion.div
          className="border-t border-border-subtle px-5 py-4"
          initial={reduce ? {} : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
        >
          <div className="flex items-center gap-4">
            <EvalScoreGauge score={agent.evalScore} size={80} delay={0.2} />
            <div className="flex-1">
              <div className="grid grid-cols-2 gap-1">
                {(agent.failedRules.length > 0
                  ? agent.rules.filter((r) => !r.pass || agent.failedRules.includes(r.name))
                  : agent.rules.filter((r) => ["no_pii", "no_injection_patterns", "no_hallucination_markers", "cost_under_threshold"].includes(r.name))
                )
                  .slice(0, 4)
                  .map((r) => (
                    <div key={r.name} className="flex items-center gap-1.5">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          r.pass ? "bg-eval-pass" : "bg-eval-fail"
                        }`}
                      />
                      <span className="text-[10px] text-text-muted">
                        {r.name.replace(/_/g, " ")}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        </motion.div>
      )}

      {/* Click hint */}
      {!revealed && (
        <div className="border-t border-border-subtle px-5 py-3 text-center">
          <span className="text-[12px] text-text-muted">
            {isChosen ? "Selected ✓" : "Click to choose"}
          </span>
        </div>
      )}
    </div>
  );
}

export function ActTwo({ onComplete, onChoice }: { onComplete: () => void; onChoice: (choice: "A" | "B") => void }) {
  const reduce = useReducedMotion();
  const [chosen, setChosen] = useState<"A" | "B" | null>(null);
  const [revealed, setRevealed] = useState(false);

  function handleChoose(side: "A" | "B") {
    setChosen(side);
    onChoice(side);
  }

  function handleReveal() {
    if (chosen) setRevealed(true);
  }

  const isCorrect = chosen === COMPARISON.correctChoice;

  return (
    <section className="border-t border-border-subtle py-10 lg:py-14">
      <div className="mx-auto max-w-5xl px-6 lg:px-8">
        {/* Section header */}
        <motion.div
          className="text-center"
          initial={reduce ? {} : { opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE }}
        >
          <span className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-bg-surface px-4 py-1.5 text-[12px] font-semibold text-text-accent">
            Act 2
          </span>
          <h2 className="mt-4 font-display text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
            Which Agent <span className="text-gradient">Ships?</span>
          </h2>
          <p className="mt-3 text-text-secondary">
            Same prompt, two agents. Pick the one you&apos;d ship to production.
          </p>
        </motion.div>

        {/* Prompt */}
        <div className="mt-10 rounded-xl border border-border-subtle bg-bg-surface px-5 py-3 text-center">
          <span className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Prompt:{" "}
          </span>
          <span className="text-sm text-text-primary">&quot;{COMPARISON.prompt}&quot;</span>
        </div>

        {/* Side by side */}
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          <AgentCard
            agent={COMPARISON.agentA}
            side="A"
            chosen={chosen}
            revealed={revealed}
            onClick={() => handleChoose("A")}
          />
          <AgentCard
            agent={COMPARISON.agentB}
            side="B"
            chosen={chosen}
            revealed={revealed}
            onClick={() => handleChoose("B")}
          />
        </div>

        {/* Reveal button or result */}
        <div className="mt-8">
          <AnimatePresence mode="wait">
            {!revealed ? (
              <motion.div
                key="reveal-btn"
                className="flex justify-center"
                initial={reduce ? {} : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <button
                  onClick={handleReveal}
                  disabled={!chosen}
                  className={`rounded-xl px-8 py-3 text-[14px] font-semibold transition-all ${
                    chosen
                      ? "bg-iris-600 text-white hover:bg-iris-500"
                      : "cursor-not-allowed bg-bg-surface text-text-muted"
                  }`}
                >
                  Reveal Iris Scores
                </button>
              </motion.div>
            ) : (
              <motion.div
                key="result"
                initial={reduce ? {} : { opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.8, ease: EASE }}
              >
                {/* Comparison bar */}
                <div className="mx-auto max-w-lg rounded-xl border border-border-subtle bg-bg-card px-6 py-4">
                  <div className="mb-3 flex items-center justify-between text-[12px]">
                    <span className="font-mono font-bold text-eval-fail">
                      Agent A: {COMPARISON.agentA.evalScore.toFixed(2)}
                    </span>
                    <span className="font-mono font-bold text-eval-pass">
                      Agent B: {COMPARISON.agentB.evalScore.toFixed(2)}
                    </span>
                  </div>
                  <div className="relative h-3 overflow-hidden rounded-full bg-bg-surface">
                    <motion.div
                      className="absolute inset-y-0 left-0 rounded-full bg-eval-fail/50"
                      initial={{ width: 0 }}
                      animate={{
                        width: `${(COMPARISON.agentA.evalScore / (COMPARISON.agentA.evalScore + COMPARISON.agentB.evalScore)) * 100}%`,
                      }}
                      transition={{ duration: 0.6, delay: 1.0, ease: EASE }}
                    />
                    <motion.div
                      className="absolute inset-y-0 right-0 rounded-full bg-eval-pass/50"
                      initial={{ width: 0 }}
                      animate={{
                        width: `${(COMPARISON.agentB.evalScore / (COMPARISON.agentA.evalScore + COMPARISON.agentB.evalScore)) * 100}%`,
                      }}
                      transition={{ duration: 0.6, delay: 1.0, ease: EASE }}
                    />
                  </div>
                  <motion.div
                    className="mt-4 text-center"
                    initial={reduce ? {} : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 1.4, duration: 0.3 }}
                  >
                    <p className="text-[13px] text-text-secondary">
                      {isCorrect ? (
                        <span className="text-eval-pass font-semibold">
                          Correct! You picked the safe agent.
                        </span>
                      ) : (
                        <span className="text-eval-warn font-semibold">
                          Agent A sounds helpful, but it leaks PII.
                        </span>
                      )}
                    </p>
                    <p className="mt-2 text-[12px] text-text-muted">
                      {COMPARISON.lesson}
                    </p>
                  </motion.div>
                </div>

                {/* Continue */}
                <div className="mt-8 flex justify-center">
                  <button
                    onClick={onComplete}
                    className="rounded-xl bg-iris-600 px-6 py-3 text-[14px] font-semibold text-white transition-all hover:bg-iris-500"
                  >
                    Explore the Dashboard →
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}
