"use client";

import { useState, useRef, useCallback } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { ScenarioOutput } from "./scenario-output";
import { EvalReveal } from "./eval-reveal";
import { SCENARIOS } from "./playground-data";

const EASE = [0.22, 1, 0.36, 1] as const;

export function ActOne({ onComplete }: { onComplete: () => void }) {
  const reduce = useReducedMotion();
  const [activeIdx, setActiveIdx] = useState(0);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [userGuess, setUserGuess] = useState<Record<number, "PASS" | "FAIL">>({});
  const sectionRef = useRef<HTMLDivElement>(null);
  const scenarioRef = useRef<HTMLDivElement>(null);

  const scenario = SCENARIOS[activeIdx];
  const isRevealed = revealed.has(activeIdx);
  const allRevealed = revealed.size === SCENARIOS.length;

  // Scroll the scenario card into view with offset for sticky headers
  const scrollToScenario = useCallback(() => {
    setTimeout(() => {
      if (scenarioRef.current) {
        const headerOffset = 120; // sticky nav + progress bar
        const elementPosition = scenarioRef.current.getBoundingClientRect().top + window.scrollY;
        window.scrollTo({ top: elementPosition - headerOffset, behavior: "smooth" });
      }
    }, 50);
  }, []);

  function handleGuess(guess: "PASS" | "FAIL") {
    setUserGuess((prev) => ({ ...prev, [activeIdx]: guess }));
    setRevealed((prev) => new Set(prev).add(activeIdx));
  }

  function handleTabSwitch(idx: number) {
    setActiveIdx(idx);
    scrollToScenario();
  }

  function handleNext() {
    if (activeIdx < SCENARIOS.length - 1) {
      setActiveIdx(activeIdx + 1);
      scrollToScenario();
    } else {
      onComplete();
    }
  }

  return (
    <section ref={sectionRef} className="py-10 lg:py-14">
      <div className="mx-auto max-w-4xl px-6 lg:px-8">
        {/* Section header */}
        <motion.div
          className="text-center"
          initial={reduce ? {} : { opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE }}
        >
          <span className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-bg-surface px-4 py-1.5 text-[12px] font-semibold text-text-accent">
            Act 1
          </span>
          <h2 className="mt-4 font-display text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
            Spot the <span className="text-gradient">Failure</span>
          </h2>
          <p className="mt-3 text-text-secondary">
            Read the agent output. Would you ship this? Click PASS or FAIL — then see what Iris catches.
          </p>
        </motion.div>

        {/* Scenario tabs */}
        <div className="mt-8 flex justify-center gap-2">
          {SCENARIOS.map((s, i) => (
            <button
              key={s.id}
              onClick={() => handleTabSwitch(i)}
              className={`rounded-lg px-4 py-2 text-[13px] font-medium transition-colors ${
                i === activeIdx
                  ? "bg-iris-600 text-white"
                  : revealed.has(i)
                    ? "border border-border-subtle bg-bg-surface text-text-secondary"
                    : "text-text-muted hover:bg-border-subtle hover:text-text-secondary"
              }`}
            >
              {s.title}
              {revealed.has(i) && (
                <span className="ml-1.5 text-[10px]">
                  {userGuess[i] === s.verdict ? "✓" : "✗"}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Active scenario */}
        <div ref={scenarioRef}>
          <AnimatePresence mode="wait">
            <motion.div
              key={scenario.id}
              initial={reduce ? {} : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? {} : { opacity: 0, y: -8 }}
              transition={{ duration: 0.3, ease: EASE }}
              className="mt-6"
            >
              <ScenarioOutput
                prompt={scenario.prompt}
                output={scenario.output}
                highlights={scenario.highlights}
                showHighlights={isRevealed}
                costIndicator={scenario.costIndicator}
              />

              {/* PASS / FAIL buttons or Eval reveal */}
              <div className="mt-6">
                <AnimatePresence mode="wait">
                  {!isRevealed ? (
                    <motion.div
                      key="buttons"
                      className="flex justify-center gap-4"
                      initial={reduce ? {} : { opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2 }}
                    >
                      <button
                        onClick={() => handleGuess("PASS")}
                        className="rounded-xl border border-eval-pass/30 bg-eval-pass/5 px-8 py-3 font-mono text-sm font-bold text-eval-pass transition-all hover:bg-eval-pass/10 hover:border-eval-pass/50"
                      >
                        PASS — Ship it
                      </button>
                      <button
                        onClick={() => handleGuess("FAIL")}
                        className="rounded-xl border border-eval-fail/30 bg-eval-fail/5 px-8 py-3 font-mono text-sm font-bold text-eval-fail transition-all hover:bg-eval-fail/10 hover:border-eval-fail/50"
                      >
                        FAIL — Block it
                      </button>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="reveal"
                      initial={reduce ? {} : { opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.2 }}
                    >
                      {/* User's guess feedback */}
                      <div className="mb-4 text-center">
                        <span className="text-[13px] text-text-muted">
                          You said{" "}
                          <span
                            className={`font-mono font-bold ${
                              userGuess[activeIdx] === scenario.verdict
                                ? "text-eval-pass"
                                : "text-eval-fail"
                            }`}
                          >
                            {userGuess[activeIdx]}
                          </span>
                          {" — "}
                          {userGuess[activeIdx] === scenario.verdict
                            ? "correct!"
                            : `Iris says ${scenario.verdict}.`}
                        </span>
                      </div>

                      <EvalReveal
                        score={scenario.evalScore}
                        verdict={scenario.verdict}
                        rules={scenario.rules}
                        failedRule={scenario.failedRule}
                        lesson={scenario.lesson}
                      />

                      {/* Next button */}
                      <div className="mt-6 flex justify-center">
                        <button
                          onClick={handleNext}
                          className="rounded-xl bg-iris-600 px-6 py-3 text-[14px] font-semibold text-white transition-all hover:bg-iris-500"
                        >
                          {activeIdx < SCENARIOS.length - 1
                            ? "Next scenario →"
                            : allRevealed
                              ? "Continue to Act 2 →"
                              : "Next scenario →"}
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}
