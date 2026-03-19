"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { SCENARIOS } from "./playground-data";

const INSTALL_CMD = "npx @iris-eval/mcp-server@latest";
const EASE = [0.22, 1, 0.36, 1] as const;

interface PlaygroundSession {
  act1Guesses: Record<number, "PASS" | "FAIL">;
  act1CorrectCount: number;
  completedActs: number;
}

const MISS_CONSEQUENCES: Record<string, string> = {
  no_pii: "In production, that miss could expose customer credit cards.",
  no_hallucination_markers: "Hedging like that erodes user trust over time.",
  no_injection_patterns: "That injection pattern would have leaked your system prompt.",
  cost_under_threshold: "At scale, that cost overrun adds up to $14,100/month.",
};

function getConsequence(session: PlaygroundSession): string {
  // Find the first scenario the user got wrong
  for (let i = 0; i < SCENARIOS.length; i++) {
    const guess = session.act1Guesses[i];
    if (guess && guess !== SCENARIOS[i].verdict) {
      return MISS_CONSEQUENCES[SCENARIOS[i].failedRule] || "";
    }
  }
  return "Now imagine doing that for every agent call, automatically.";
}

export function PlaygroundCta({ session }: { session: PlaygroundSession }) {
  const reduce = useReducedMotion();
  const [copied, setCopied] = useState(false);
  const correct = session.act1CorrectCount;
  const hasSession = Object.keys(session.act1Guesses).length > 0;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(INSTALL_CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  }

  return (
    <section className="border-t border-border-subtle py-10 lg:py-14">
      <div className="mx-auto max-w-3xl px-6 text-center lg:px-8">
        <motion.div
          initial={reduce ? {} : { opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE }}
        >
          {/* Personalized summary */}
          {hasSession ? (
            <>
              <h2 className="font-display text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
                You found{" "}
                <span className={correct === 4 ? "text-eval-pass" : "text-eval-warn"}>
                  {correct}/4
                </span>{" "}
                failures. Iris found{" "}
                <span className="text-gradient">4/4</span> in 0.012s.
              </h2>
              <p className="mt-4 text-lg text-text-secondary">
                {getConsequence(session)}
              </p>
            </>
          ) : (
            <>
              <h2 className="font-display text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
                Ready to eval your <span className="text-gradient">agents?</span>
              </h2>
              <p className="mt-4 text-lg text-text-secondary">
                Everything you just experienced is what you get when you install Iris.
                No signup. No SDK. One command.
              </p>
            </>
          )}

          {/* Install command */}
          <div className="mx-auto mt-8 max-w-lg">
            <div className="flex items-center gap-2 rounded-xl border border-border-subtle bg-bg-card px-5 py-4">
              <span className="text-text-muted select-none">$</span>
              <code className="flex-1 text-left font-mono text-sm text-text-primary">
                {INSTALL_CMD}
              </code>
              <button
                onClick={handleCopy}
                aria-label="Copy install command to clipboard"
                className="shrink-0 rounded-lg border border-border-subtle px-3 py-1.5 text-[12px] font-medium text-text-secondary transition-all hover:border-border-glow hover:text-text-primary"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>

          {/* Action buttons */}
          <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <a
              href="https://github.com/iris-eval/mcp-server"
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex items-center rounded-xl bg-iris-600 px-8 py-4 text-[15px] font-semibold text-white shadow-lg shadow-iris-600/20 transition-all hover:bg-iris-500 hover:shadow-iris-500/30"
            >
              Star on GitHub
              <svg
                className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-0.5"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M3 8h10M9 4l4 4-4 4" />
              </svg>
            </a>
            <a
              href="/#pricing"
              className="inline-flex items-center rounded-xl border border-border-default px-8 py-4 text-[15px] font-semibold text-text-secondary transition-all hover:border-border-glow hover:text-text-primary"
            >
              Want managed hosting?
            </a>
          </div>

          {/* Social proof */}
          <div className="mt-8 flex items-center justify-center gap-6 text-[13px] text-text-muted">
            <span>Open Source</span>
            <span className="h-3 w-px bg-border-subtle" />
            <span>MIT Licensed</span>
            <span className="h-3 w-px bg-border-subtle" />
            <span>Self-hosted</span>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
