"use client";

import { useState, useEffect } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

const WORDS = ["actually doing.", "actually leaking.", "actually costing."];

export function RotatingWords(): React.ReactElement {
  const [index, setIndex] = useState(0);
  const reduce = useReducedMotion();

  useEffect(() => {
    const interval = setInterval(() => {
      setIndex((prev) => (prev + 1) % WORDS.length);
    }, 2800);
    return () => clearInterval(interval);
  }, []);

  if (reduce) {
    return <span className="text-gradient">{WORDS[0]}</span>;
  }

  return (
    <span className="relative inline-grid [grid-template-area:'stack']">
      <AnimatePresence mode="wait">
        <motion.span
          key={WORDS[index]}
          initial={{ opacity: 0, y: "100%" }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: "-100%" }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          className="text-gradient [grid-area:stack]"
        >
          {WORDS[index]}
        </motion.span>
      </AnimatePresence>
      {/* Invisible sizer — occupies the width of the longest word */}
      <span className="invisible [grid-area:stack]" aria-hidden="true">
        actually costing.
      </span>
    </span>
  );
}
