"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ActOne } from "./act-one";
import { ActTwo } from "./act-two";
import { ActThree } from "./act-three";
import { PlaygroundCta } from "./playground-cta";

const EASE = [0.22, 1, 0.36, 1] as const;

export function PlaygroundShell() {
  const reduce = useReducedMotion();
  const [visibleActs, setVisibleActs] = useState(1);
  const actTwoRef = useRef<HTMLDivElement>(null);
  const actThreeRef = useRef<HTMLDivElement>(null);

  function unlockAct(act: number) {
    setVisibleActs((prev) => Math.max(prev, act));
  }

  // Scroll to newly unlocked act with a delay so the DOM has rendered
  useEffect(() => {
    const ref = visibleActs === 2 ? actTwoRef : visibleActs === 3 ? actThreeRef : null;
    if (ref?.current) {
      // Small delay to let React render the new act before scrolling
      const timer = setTimeout(() => {
        ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [visibleActs]);

  // Expose scroll helper for child components
  const scrollToAct = useCallback((ref: React.RefObject<HTMLDivElement | null>) => {
    if (ref.current) {
      const headerOffset = 80; // sticky nav height
      const elementPosition = ref.current.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: elementPosition - headerOffset, behavior: "smooth" });
    }
  }, []);

  return (
    <div>
      {/* Sticky progress indicator */}
      <div className="sticky top-[56px] z-30 border-b border-border-subtle bg-bg-base/80 backdrop-blur-xl">
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

      {/* Hero — tighter spacing */}
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
          </motion.div>
        </div>
      </section>

      {/* Act 1 — always visible */}
      <ActOne onComplete={() => unlockAct(2)} />

      {/* Act 2 — unlocked after Act 1 */}
      {visibleActs >= 2 && (
        <div ref={actTwoRef}>
          <ActTwo onComplete={() => unlockAct(3)} />
        </div>
      )}

      {/* Act 3 — unlocked after Act 2 */}
      {visibleActs >= 3 && (
        <div ref={actThreeRef}>
          <ActThree />
          <PlaygroundCta />
        </div>
      )}
    </div>
  );
}
