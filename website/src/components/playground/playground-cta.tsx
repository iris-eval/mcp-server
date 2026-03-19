"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";

const INSTALL_CMD = "npx @iris-eval/mcp-server@latest";
const EASE = [0.22, 1, 0.36, 1] as const;

export function PlaygroundCta() {
  const reduce = useReducedMotion();
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(INSTALL_CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback: select the text
    }
  }

  return (
    <section className="border-t border-border-subtle py-20 lg:py-28">
      <div className="mx-auto max-w-3xl px-6 text-center lg:px-8">
        <motion.div
          initial={reduce ? {} : { opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE }}
        >
          <h2 className="font-display text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
            Ready to eval your <span className="text-gradient">agents?</span>
          </h2>
          <p className="mt-4 text-lg text-text-secondary">
            Everything you just experienced is what you get when you install Iris.
            No signup. No SDK. One command.
          </p>

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
