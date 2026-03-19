"use client";

import { motion, useReducedMotion } from "framer-motion";

const EASE = [0.22, 1, 0.36, 1] as const;

interface PlaygroundSession {
  act1CorrectCount: number;
  completedActs: number;
}

interface ResultCardProps {
  session: PlaygroundSession;
}

function getMessage(correct: number): { headline: string; sub: string } {
  if (correct === 4) {
    return {
      headline: "You matched Iris.",
      sub: "But can you do it at 1,000 evals per second?",
    };
  }
  if (correct === 3) {
    return {
      headline: "Close.",
      sub: "Iris catches the ones humans miss.",
    };
  }
  return {
    headline: "This is why you need automated eval.",
    sub: `You missed ${4 - correct} failure${4 - correct > 1 ? "s" : ""} that Iris caught instantly.`,
  };
}

function getShareText(correct: number): string {
  if (correct === 4) {
    return "I spotted all 4 agent failures in the @iris_eval playground. Can you?\n\nTry agent eval in 60 seconds:";
  }
  if (correct === 3) {
    return "I found 3/4 agent failures. Iris found 4/4 in 0.012s. The playground shows why automated eval matters:";
  }
  return `I missed ${4 - correct} agent failure${4 - correct > 1 ? "s" : ""} that @iris_eval caught instantly. Try the playground:`;
}

export function ResultCard({ session, track }: ResultCardProps & { track: (event: string, data?: Record<string, string | number>) => void }) {
  const reduce = useReducedMotion();
  const { act1CorrectCount } = session;
  const msg = getMessage(act1CorrectCount);

  function handleShare() {
    track("result_shared", { score: act1CorrectCount });
    const text = getShareText(act1CorrectCount);
    const url = "https://iris-eval.com/playground";
    window.open(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
      "_blank",
      "width=550,height=420",
    );
  }

  return (
    <motion.div
      className="border-t border-border-subtle py-10 lg:py-14"
      initial={reduce ? {} : { opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE }}
    >
      <div className="mx-auto max-w-lg px-6 lg:px-8">
        <div className="overflow-hidden rounded-2xl border border-border-subtle bg-bg-card shadow-2xl shadow-black/20">
          {/* Teal accent bar */}
          <div className="h-1 bg-gradient-to-r from-iris-600 via-iris-400 to-iris-600" />

          <div className="p-8 text-center">
            {/* Logo + title */}
            <div className="flex items-center justify-center gap-2">
              <svg width="24" height="24" viewBox="0 0 40 40" fill="none">
                <circle cx="20" cy="20" r="17" stroke="#14b8a6" strokeWidth="3" />
                <circle cx="20" cy="20" r="10" fill="#0d9488" />
                <circle cx="20" cy="20" r="4.5" fill="#0a0f0e" />
                <circle cx="17" cy="17.5" r="2" fill="white" opacity="0.6" />
              </svg>
              <span className="text-[11px] font-bold uppercase tracking-[0.15em] text-text-muted">
                Your Agent Eval Score
              </span>
            </div>

            {/* Score comparison */}
            <div className="mt-8 flex items-end justify-center gap-6 sm:gap-10">
              <div>
                <div className="font-display text-5xl font-extrabold text-text-primary">
                  {act1CorrectCount}/4
                </div>
                <div className="mt-1 text-[13px] text-text-muted">You</div>
              </div>
              <div className="mb-2 text-[13px] font-medium text-text-muted">vs</div>
              <div>
                <div className="font-display text-5xl font-extrabold text-eval-pass">
                  4/4
                </div>
                <div className="mt-1 text-[13px] text-text-accent">Iris</div>
              </div>
            </div>

            {/* Message */}
            <motion.div
              className="mt-8"
              initial={reduce ? {} : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3, duration: 0.4, ease: EASE }}
            >
              <p className="text-lg font-semibold text-text-primary">
                {msg.headline}
              </p>
              <p className="mt-1 text-[14px] text-text-secondary">
                {msg.sub}
              </p>
            </motion.div>

            {/* Share button */}
            <motion.div
              className="mt-8"
              initial={reduce ? {} : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5, duration: 0.3 }}
            >
              <button
                onClick={handleShare}
                aria-label="Share your result on X"
                className="inline-flex items-center gap-2 rounded-xl bg-iris-600 px-6 py-3 text-[14px] font-semibold text-white transition-all hover:bg-iris-500"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
                Share your result
              </button>
            </motion.div>

            {/* Footer */}
            <div className="mt-6 text-[12px] text-text-muted">
              iris-eval.com/playground
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
