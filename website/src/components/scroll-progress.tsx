"use client";

import { motion, useScroll, useSpring, useReducedMotion } from "framer-motion";

export function ScrollProgress(): React.ReactElement {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 120, damping: 30, restDelta: 0.001 });
  const reduce = useReducedMotion();

  if (reduce) return <></>;

  return (
    <motion.div
      className="fixed top-0 right-0 left-0 z-[60] h-[2px] origin-left bg-gradient-to-r from-iris-600 via-iris-400 to-iris-300"
      style={{ scaleX }}
    />
  );
}
