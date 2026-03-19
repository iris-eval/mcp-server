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
        <span>MCP-native eval</span>
        <span className="h-3 w-px bg-border-subtle" />
        <span>Works with Claude, GPT, Gemini, LangChain</span>
        <span className="hidden h-3 w-px bg-border-subtle md:inline" />
        <span className="hidden md:inline">12 eval rules</span>
        <span className="hidden h-3 w-px bg-border-subtle md:inline" />
        <span className="hidden md:inline">Open source · MIT licensed</span>
      </div>
    </motion.div>
  );
}
