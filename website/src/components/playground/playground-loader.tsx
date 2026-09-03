"use client";

import dynamic from "next/dynamic";

// The shell is client-only (ssr: false), so this `loading` element is the
// only markup the server sends for /playground. It carries the page's real
// H1 — the same heading the shell renders once it mounts — so a crawler (and
// a reader on a slow connection) gets a heading instead of a spinner. The
// shell replaces this element wholesale, so the page never has two H1s.
const PlaygroundShell = dynamic(
  () =>
    import("./playground-shell").then((m) => m.PlaygroundShell),
  {
    ssr: false,
    loading: () => (
      <section className="relative overflow-hidden pt-16 pb-8 lg:pt-20 lg:pb-12">
        <div className="relative mx-auto max-w-4xl px-6 text-center lg:px-8">
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
          <div className="mx-auto mt-10 h-8 w-8 animate-spin rounded-full border-2 border-iris-600 border-t-transparent" />
          <p className="mt-4 text-sm text-text-muted">Loading playground...</p>
        </div>
      </section>
    ),
  },
);

export function PlaygroundLoader() {
  return <PlaygroundShell />;
}
