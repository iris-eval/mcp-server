"use client";

import { motion, useReducedMotion } from "framer-motion";

const EASE = [0.22, 1, 0.36, 1] as const;

export function SocialProofBar() {
  const reduce = useReducedMotion();

  return (
    <motion.div
      className="border-y border-border-subtle bg-bg-raised/50 py-3"
      initial={reduce ? {} : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.5, duration: 0.4, ease: EASE }}
    >
      <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-center gap-4 px-6 text-[13px] text-text-muted md:gap-6">
        <span className="flex items-center gap-1.5">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="text-eval-warn">
            <path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25z" />
          </svg>
          120+ stars
        </span>
        <span className="h-3 w-px bg-border-subtle" />
        <span>Works with Claude · GPT · Gemini · LangChain</span>
        <span className="hidden h-3 w-px bg-border-subtle md:inline" />
        <span className="hidden md:inline">12 eval rules</span>
        <span className="hidden h-3 w-px bg-border-subtle md:inline" />
        <span className="hidden md:inline">Open source · MIT</span>
      </div>
    </motion.div>
  );
}
