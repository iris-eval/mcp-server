"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ActOne } from "./act-one";
import { ActTwo } from "./act-two";
import { ActThree } from "./act-three";
import { CompletedActPill } from "./completed-act-pill";
import { PlaygroundCta } from "./playground-cta";
import { SocialProofBar } from "./social-proof-bar";
import { ResultCard } from "./result-card";
import { usePlaygroundAnalytics } from "./use-playground-analytics";
import { SCENARIOS, COMPARISON } from "./playground-data";

const EASE = [0.22, 1, 0.36, 1] as const;

export interface PlaygroundSession {
  act1Guesses: Record<number, "PASS" | "FAIL">;
  act1CorrectCount: number;
  act2Choice: "A" | "B" | null;
  act2Correct: boolean;
  completedActs: number;
}

const INITIAL_SESSION: PlaygroundSession = {
  act1Guesses: {},
  act1CorrectCount: 0,
  act2Choice: null,
  act2Correct: false,
  completedActs: 0,
};

export function PlaygroundShell() {
  const reduce = useReducedMotion();
  const { track } = usePlaygroundAnalytics();
  const [visibleActs, setVisibleActs] = useState(1);
  const [session, setSession] = useState<PlaygroundSession>(INITIAL_SESSION);
  const [previousBest, setPreviousBest] = useState<number | null>(null);
  const actTwoRef = useRef<HTMLDivElement>(null);
  const actThreeRef = useRef<HTMLDivElement>(null);

  // Track playground loaded + load previous best score
  useEffect(() => {
    track("playground_loaded");
    const prev = localStorage.getItem("iris-playground-best");
    if (prev) setPreviousBest(parseInt(prev));
  }, [track]);

  // Save best score on completion
  useEffect(() => {
    if (session.completedActs >= 3) {
      const prev = localStorage.getItem("iris-playground-best");
      const prevScore = prev ? parseInt(prev) : 0;
      if (session.act1CorrectCount > prevScore) {
        localStorage.setItem("iris-playground-best", String(session.act1CorrectCount));
      }
    }
  }, [session.completedActs, session.act1CorrectCount]);

  function unlockAct(act: number) {
    setVisibleActs((prev) => Math.max(prev, act));
    setSession((prev) => ({ ...prev, completedActs: Math.max(prev.completedActs, act - 1) }));
    if (act === 3) track("act2_completed");
  }

  // Scroll to newly unlocked act
  useEffect(() => {
    const ref = visibleActs === 2 ? actTwoRef : visibleActs === 3 ? actThreeRef : null;
    if (ref?.current) {
      const timer = setTimeout(() => {
        ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [visibleActs]);

  // Act 1 guess tracking
  const onAct1Guess = useCallback((scenarioIdx: number, guess: "PASS" | "FAIL") => {
    setSession((prev) => {
      const newGuesses = { ...prev.act1Guesses, [scenarioIdx]: guess };
      const correctCount = Object.entries(newGuesses).filter(
        ([idx, g]) => g === SCENARIOS[Number(idx)].verdict,
      ).length;
      return { ...prev, act1Guesses: newGuesses, act1CorrectCount: correctCount };
    });
  }, []);

  // Act 2 choice tracking
  const onAct2Choice = useCallback((choice: "A" | "B") => {
    setSession((prev) => ({
      ...prev,
      act2Choice: choice,
      act2Correct: choice === COMPARISON.correctChoice,
    }));
  }, []);

  return (
    <div>
      {/* Sticky progress indicator */}
      <div className="sticky top-[56px] z-30 border-b border-border-subtle bg-bg-base/80 backdrop-blur-xl" aria-label="Playground progress">
        <div className="mx-auto flex max-w-4xl items-center justify-center gap-3 px-6 py-3">
          {[
            { num: 1, label: "Spot the Failure" },
            { num: 2, label: "Which Ships?" },
            { num: 3, label: "Dashboard" },
          ].map((act, i) => (
            <div key={act.num} className="flex items-center gap-3">
              {i > 0 && (
                <div
                  className={`h-px w-8 transition-colors duration-500 ${
                    visibleActs >= act.num ? "bg-iris-500" : "bg-border-subtle"
                  }`}
                />
              )}
              <div className="flex items-center gap-2">
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold transition-colors duration-500 ${
                    visibleActs >= act.num
                      ? "bg-iris-600 text-white"
                      : "bg-bg-surface text-text-muted"
                  }`}
                >
                  {act.num}
                </span>
                <span
                  className={`hidden text-[12px] font-medium transition-colors duration-500 sm:inline ${
                    visibleActs >= act.num ? "text-text-primary" : "text-text-muted"
                  }`}
                >
                  {act.label}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Hero */}
      <section className="relative overflow-hidden pt-16 pb-8 lg:pt-20 lg:pb-12">
        <div className="hero-glow absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-20" aria-hidden="true" />
        <div className="relative mx-auto max-w-4xl px-6 text-center lg:px-8">
          <motion.div
            initial={reduce ? {} : { opacity: 0, y: 28 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: EASE }}
          >
            <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">
              Interactive Demo
            </p>
            <h1 className="mt-4 font-display text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
              Try Agent Eval in{" "}
              <span className="text-gradient">60 Seconds</span>
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-lg text-text-secondary">
              Judge agent output. See how Iris scores it. Explore the eval dashboard.
              No install, no signup.
            </p>
            {previousBest !== null && (
              <p className="mt-3 text-[13px] text-text-accent">
                Your previous score: {previousBest}/4. Try to beat it.
              </p>
            )}
          </motion.div>
        </div>
      </section>

      {/* Social proof */}
      <SocialProofBar />

      {/* Act 1 — full when current, pill when past */}
      {visibleActs === 1 ? (
        <ActOne onComplete={() => unlockAct(2)} onGuess={onAct1Guess} track={track} />
      ) : (
        <CompletedActPill
          actNumber={1}
          title="Spot the Failure"
          summary={`${session.act1CorrectCount}/${SCENARIOS.length} correct`}
          accent={session.act1CorrectCount === SCENARIOS.length ? "pass" : session.act1CorrectCount >= SCENARIOS.length / 2 ? "warn" : "neutral"}
        />
      )}

      {/* Act 2 — full when current, pill when past */}
      {visibleActs === 2 && (
        <div ref={actTwoRef}>
          <ActTwo onComplete={() => unlockAct(3)} onChoice={onAct2Choice} />
        </div>
      )}
      {visibleActs >= 3 && session.act2Choice !== null && (
        <CompletedActPill
          actNumber={2}
          title="Which Agent Ships?"
          summary={
            session.act2Correct
              ? `Picked Agent ${session.act2Choice} — correct`
              : `Picked Agent ${session.act2Choice} — Agent ${COMPARISON.correctChoice} was safer`
          }
          accent={session.act2Correct ? "pass" : "warn"}
        />
      )}

      {/* Act 3 + Result Card + CTA */}
      {visibleActs >= 3 && (
        <div ref={actThreeRef}>
          <ActThree track={track} />
          <ResultCard session={session} track={track} />
          <PlaygroundCta session={session} track={track} />
        </div>
      )}
    </div>
  );
}
