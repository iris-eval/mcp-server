"use client";

import { useRef } from "react";
import Link from "next/link";
import { motion, useReducedMotion, useInView } from "framer-motion";
import changelog from "@/lib/changelog.generated.json";

interface MilestoneRow {
  v: string;
  status: "Released" | "In progress" | "Planned";
  title: string;
  detail: string;
  // A measurement claim in `detail` must point at the measurement — the
  // hardcoded-claim scanner (measurement-claim-without-link) enforces it.
  proof?: { href: string; label: string };
}

/*
 * Rendered from the changelog, not typed (2026-09-23 review): the hand-typed
 * list stopped at v0.11 while /releases showed five minors past it, and its
 * "in progress" tracks had gone stale. Each minor release is a row, in order,
 * with the lead line its CHANGELOG section opens with; what Iris cannot judge
 * yet lives on the capability map, which is generated from the code.
 */
const RECENT_MINORS = 8;
const MILESTONES: MilestoneRow[] = [
  ...changelog.history
    .filter((r) => /^\d+\.\d+\.0$/.test(r.version) && r.lead)
    .slice(0, RECENT_MINORS)
    .reverse()
    .map((r) => ({ v: `v${r.version}`, status: "Released" as const, title: r.lead as string, detail: `Released ${r.date}.` })),
  {
    v: "Next",
    status: "Planned",
    title: "What Iris cannot judge yet",
    detail: "Every question Iris answers, answers in part, or cannot answer yet, generated from the code.",
    proof: { href: "/capabilities", label: "See the capability map" },
  },
];

function Milestone({ m, index }: { m: MilestoneRow; index: number }): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  const reduce = useReducedMotion();
  const released = m.status === "Released";

  return (
    <motion.div
      ref={ref}
      initial={reduce ? {} : { opacity: 0, x: -16 }}
      animate={inView ? { opacity: 1, x: 0 } : {}}
      transition={{ duration: 0.4, delay: index * 0.1 }}
      className={`relative ${index < MILESTONES.length - 1 ? "pb-12" : ""}`}
    >
      <div
        className={`absolute -left-[calc(2.5rem+5px)] top-1 h-4 w-4 rounded-full border-2 md:-left-[calc(3rem+5px)] ${
          released
            ? "border-iris-500 bg-iris-500 shadow-[0_0_12px_var(--iris-500)]"
            : "border-border-strong bg-bg-base"
        }`}
      />
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-[14px] font-bold text-text-accent">{m.v}</span>
        <span
          className={`rounded-full px-3 py-0.5 text-[11px] font-bold ${
            released ? "bg-eval-pass/10 text-eval-pass" : "bg-border-subtle text-text-muted"
          }`}
        >
          {m.status}
        </span>
      </div>
      <h3 className="mt-2 font-display text-lg font-bold text-text-primary md:text-xl">{m.title}</h3>
      <p className="mt-1 text-[14px] leading-relaxed text-text-secondary">{m.detail}</p>
      {m.proof && (
        <p className="mt-2 text-[13px] leading-relaxed text-text-muted">
          <Link href={m.proof.href} className="font-semibold text-text-accent hover:underline">
            {m.proof.label} &rarr;
          </Link>
        </p>
      )}
    </motion.div>
  );
}

export function Roadmap(): React.ReactElement {
  return (
    <section className="py-32 lg:py-44" id="roadmap">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">
            Roadmap
          </p>
          <h2 className="mt-4 font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl">
            Built in public. <span className="text-gradient">Shipping fast.</span>
          </h2>
        </div>

        <div className="mx-auto mt-16 max-w-2xl lg:mt-20">
          <div className="relative border-l-2 border-border-default pl-10 md:pl-12">
            {MILESTONES.map((m, i) => (
              <Milestone key={m.v} m={m} index={i} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
