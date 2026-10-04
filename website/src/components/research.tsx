import Link from "next/link";

const PUBS = [
  {
    type: "Comparison",
    date: "October 2026",
    title: "Iris vs Langfuse vs Phoenix vs Promptfoo: where each wins, where each loses",
    desc: "Four ways to evaluate an AI agent, read from each vendor's own pages on 2026-10-01: how each gets into your stack, where the evaluation runs, what it costs to run, how it self-hosts, and what it does with MCP.",
    href: "/blog/iris-vs-langfuse-vs-phoenix-vs-promptfoo",
  },
  {
    type: "Report",
    date: "March 2026",
    title: "The State of MCP Agent Observability",
    desc: "The gap between deploying AI agents and understanding what they're doing. Covers protocol-native observability, heuristic vs. semantic eval, cost visibility, and EU AI Act implications.",
    href: "/blog/state-of-mcp-agent-observability-2026",
  },
];

export function Research(): React.ReactElement {
  return (
    <section className="bg-bg-raised py-32 lg:py-44" id="research">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">
            Research
          </p>
          <h2 className="mt-4 font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl">
            Publications and insights.
          </h2>
          <p className="mt-6 text-lg leading-relaxed text-text-secondary">
            Original research on MCP agent observability, evaluation
            methodology, and the evolving landscape of AI agent infrastructure.
          </p>
        </div>

        <div className="mt-16 grid gap-6 md:grid-cols-2 lg:mt-20 lg:gap-8">
          {PUBS.map((p) => (
            <a
              key={p.title}
              href={p.href}
              className="glow-card card-premium group overflow-hidden p-8"
            >
              <div className="mb-4 flex items-center gap-3">
                <span className="rounded-lg bg-iris-500/10 px-2.5 py-1 text-[11px] font-bold text-text-accent">
                  {p.type}
                </span>
                <span className="text-[12px] text-text-muted">{p.date}</span>
              </div>
              <h3 className="font-display text-xl font-bold text-text-primary transition-colors group-hover:text-text-accent">
                {p.title}
              </h3>
              <p className="mt-3 text-[14px] leading-relaxed text-text-secondary">
                {p.desc}
              </p>
              <span className="mt-6 inline-flex items-center gap-1 text-[14px] font-semibold text-text-accent">
                Read {p.type === "Report" ? "report" : "post"}
                <svg className="h-4 w-4 transition-transform group-hover:translate-x-1" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 8h10M9 4l4 4-4 4"/></svg>
              </span>
            </a>
          ))}
        </div>

        <div className="mt-10 text-center">
          <Link href="/blog" className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-text-accent transition-colors hover:text-iris-400">
            View all posts
            <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 8h10M9 4l4 4-4 4"/></svg>
          </Link>
        </div>

        {/* Measured: the research that ships with every release */}
        <Link
          href="/proof"
          className="glow-card card-premium group mx-auto mt-12 block max-w-2xl p-8 text-center lg:mt-16"
        >
          <span className="rounded-lg bg-iris-500/10 px-2.5 py-1 text-[11px] font-bold text-text-accent">
            Measured
          </span>
          <h3 className="mt-4 font-display text-xl font-bold text-text-primary transition-colors group-hover:text-text-accent">
            {/* The measurement: https://iris-eval.com/proof */}
            Every rule&apos;s precision and recall, published
          </h3>
          <p className="mt-2 text-[14px] text-text-secondary">
            Each built-in rule is measured on a public corpus, and the proof check
            is required on every pull request: a rule change cannot merge without
            its numbers.
          </p>
        </Link>
      </div>
    </section>
  );
}
