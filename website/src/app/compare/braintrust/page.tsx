import type { Metadata } from "next";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import { IrisLogo } from "@/components/iris-logo";
import { CompareDisclaimer } from "@/components/compare-disclaimer";

export const metadata: Metadata = {
  title: "Iris vs Braintrust — MCP-Native Agent Eval vs SDK-Based Eval",
  description:
    "Detailed comparison of Iris and Braintrust for AI agent observability. MCP-native zero-code integration vs SDK-based eval platform with datasets, experiments, and prompt playground.",
  openGraph: {
    title: "Iris vs Braintrust — MCP-Native Agent Eval vs SDK-Based Eval",
    description:
      "Detailed comparison of Iris and Braintrust for AI agent observability. Zero-code MCP integration vs SDK-powered eval and experiments.",
    url: "https://iris-eval.com/compare/braintrust",
    images: ["/og-compare-braintrust.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Iris vs Braintrust — MCP-Native Agent Eval vs SDK-Based Eval",
    description:
      "Detailed comparison of Iris and Braintrust. Zero-code MCP integration vs SDK-powered eval platform.",
    images: ["/og-compare-braintrust.png"],
    site: "@iris_eval",
  },
};

const FEATURES = [
  { feature: "Integration method", iris: "MCP config (zero code)", braintrust: "SDK imports (Python, TS, Go, Ruby, C#)", irisWin: true },
  { feature: "Self-hosting", iris: "Single SQLite file", braintrust: "Enterprise plan only (cloud-first)", irisWin: true },
  { feature: "Performance overhead", iris: "Zero (no SDK in hot path)", braintrust: "Async logging, minimal overhead", irisWin: true },
  { feature: "Eval approach", iris: "12 built-in + 8 custom heuristic rules (<1ms)", braintrust: "LLM, code, and human scoring + datasets + experiments", braintrustWin: true },
  { feature: "Prompt playground", iris: "Not included", braintrust: "Full playground with side-by-side comparison", braintrustWin: true, irisNeutral: true },
  { feature: "Datasets & experiments", iris: "Not included", braintrust: "Production traces to datasets, experiment tracking, CI integration", braintrustWin: true, irisNeutral: true },
  { feature: "Cost tracking", iris: "Per-trace USD cost", braintrust: "Per-trace cost, per-user/feature/model breakdowns", braintrustWin: true },
  { feature: "MCP support", iris: "Protocol-native (IS an MCP server)", braintrust: "MCP server for querying Braintrust data", irisWin: true },
  { feature: "License", iris: "MIT (fully permissive)", braintrust: "Proprietary (proxy is MIT)", irisWin: true },
  { feature: "Pricing", iris: "Free & open-source", braintrust: "Free tier (1M spans) / Pro $249/mo / Enterprise custom", irisWin: true },
  { feature: "Tracing depth", iris: "MCP tool calls and agent traces", braintrust: "Full trace trees with token-level detail, visual timeline", braintrustWin: true },
  { feature: "Enterprise features", iris: "Roadmap (v0.5)", braintrust: "SOC 2, SSO, hybrid deployment, dedicated support", braintrustWin: true, irisNeutral: true },
];

const IRIS_REASONS = [
  "You're building with MCP-compatible agents (Claude Desktop, Cursor, Windsurf)",
  "You want zero-code integration — no SDK imports, no wrapper functions",
  "You want simple self-hosting — one binary, one SQLite file, no cloud dependency",
  "You want fully permissive MIT licensing with no proprietary modules",
  "You want sub-millisecond heuristic eval that runs locally without LLM calls",
  "You want to avoid per-seat or usage-based pricing",
];

const BRAINTRUST_REASONS = [
  "You need deep eval capabilities — datasets, experiments, human review, LLM scoring",
  "You need a prompt playground for iterating on prompts with real data",
  "You need enterprise compliance today (SOC 2, SSO, hybrid deployment)",
  "You need multi-language SDK support (Python, TypeScript, Go, Ruby, C#)",
  "You need granular cost analytics sliced by user, feature, or model",
  "You need CI/CD-integrated regression testing against production datasets",
];

export default function CompareBraintrust(): React.ReactElement {
  return (
    <>
      <Nav />

      {/* Hero */}
      <section className="relative overflow-hidden bg-bg-base pb-12 pt-32 text-center lg:pt-40">
        <div className="glow-hero absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-30" aria-hidden="true" />
        <div className="relative mx-auto max-w-4xl px-6">
          <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">
            Comparison
          </p>
          <h1 className="mt-4 font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl lg:text-6xl">
            <span className="text-gradient">Iris</span> vs Braintrust
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-text-secondary">
            MCP-native, zero-code observability vs SDK-powered eval and
            experimentation platform. Two different philosophies for AI quality.
          </p>
        </div>
      </section>

      {/* TL;DR */}
      <section className="bg-bg-base pb-16">
        <div className="mx-auto max-w-3xl px-6">
          <p className="mb-6 text-center text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">
            TL;DR
          </p>
          <div className="rounded-2xl border border-border-default bg-bg-card p-8 text-[15px] leading-relaxed text-text-secondary">
            <strong className="text-text-primary">Iris</strong> is an MCP server
            your agent discovers and uses automatically — zero code changes, zero
            SDK imports, one SQLite file for storage. Eval runs locally with
            sub-millisecond heuristic rules.{" "}
            <strong className="text-text-primary">Braintrust</strong> is a
            comprehensive eval and observability platform with powerful dataset
            management, experiment tracking, a prompt playground, and deep
            tracing. If you&apos;re building with MCP-compatible agents and want
            the simplest possible setup with local eval, Iris gets you there in
            60 seconds. If you need production-grade experimentation workflows,
            human review, or CI-integrated regression testing, Braintrust is the
            deeper eval platform.
          </div>
        </div>
      </section>

      {/* Feature comparison table */}
      <section className="bg-bg-base pb-20">
        <div className="mx-auto max-w-5xl px-6">
          <div className="mb-10 text-center">
            <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">
              Feature Comparison
            </p>
            <h2 className="mt-4 font-display text-3xl font-extrabold tracking-tight text-text-primary md:text-4xl">
              Side by side.
            </h2>
          </div>
          <div className="overflow-x-auto rounded-2xl border border-border-default bg-bg-card">
            <table className="w-full text-left text-[14px]">
              <thead>
                <tr className="border-b border-border-default">
                  <th className="px-6 py-4 text-[12px] font-bold uppercase tracking-wider text-text-muted">Feature</th>
                  <th className="px-6 py-4 text-[12px] font-bold uppercase tracking-wider text-text-accent">Iris</th>
                  <th className="px-6 py-4 text-[12px] font-bold uppercase tracking-wider text-eval-pass">Braintrust</th>
                </tr>
              </thead>
              <tbody>
                {FEATURES.map((row) => (
                  <tr key={row.feature} className="border-b border-border-subtle last:border-b-0 transition-colors hover:bg-iris-600/[0.02]">
                    <td className="px-6 py-4 font-semibold text-text-primary whitespace-nowrap">{row.feature}</td>
                    <td className={`px-6 py-4 ${row.irisWin ? "font-medium text-text-accent" : row.irisNeutral ? "text-text-muted" : "text-text-secondary"}`}>
                      {row.iris}
                    </td>
                    <td className={`px-6 py-4 ${row.braintrustWin ? "font-medium text-eval-pass" : "text-text-secondary"}`}>
                      {row.braintrust}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* When to choose */}
      <section className="bg-bg-base pb-20">
        <div className="mx-auto max-w-5xl px-6">
          <div className="mb-10 text-center">
            <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">
              Decision Guide
            </p>
            <h2 className="mt-4 font-display text-3xl font-extrabold tracking-tight text-text-primary md:text-4xl">
              Which one fits your stack?
            </h2>
          </div>
          <div className="grid gap-8 md:grid-cols-2">
            {/* Iris card */}
            <div className="rounded-2xl border border-border-default bg-bg-card p-8 transition-colors hover:border-border-glow">
              <h3 className="mb-6 flex items-center gap-3 font-display text-xl font-bold text-text-primary">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-iris-500/30 bg-iris-600/10">
                  <IrisLogo size={18} />
                </span>
                When to choose Iris
              </h3>
              <ul className="space-y-3">
                {IRIS_REASONS.map((reason) => (
                  <li key={reason} className="relative pl-4 text-[14px] leading-relaxed text-text-secondary before:absolute before:left-0 before:top-[9px] before:h-[7px] before:w-[7px] before:rounded-full before:bg-iris-500">
                    {reason}
                  </li>
                ))}
              </ul>
            </div>
            {/* Braintrust card */}
            <div className="rounded-2xl border border-border-default bg-bg-card p-8 transition-colors hover:border-border-glow">
              <h3 className="mb-6 flex items-center gap-3 font-display text-xl font-bold text-text-primary">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-eval-pass/30 bg-eval-pass/10">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                </span>
                When to choose Braintrust
              </h3>
              <ul className="space-y-3">
                {BRAINTRUST_REASONS.map((reason) => (
                  <li key={reason} className="relative pl-4 text-[14px] leading-relaxed text-text-secondary before:absolute before:left-0 before:top-[9px] before:h-[7px] before:w-[7px] before:rounded-full before:bg-eval-pass">
                    {reason}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <CompareDisclaimer lastVerified="March 2026" competitor="Braintrust" />

      {/* CTA */}
      <section className="bg-bg-base pb-20">
        <div className="mx-auto max-w-3xl px-6 text-center">
          <h2 className="font-display text-3xl font-extrabold tracking-tight text-text-primary md:text-4xl">
            Ready to see what your agents are doing?
          </h2>
          <p className="mt-5 text-lg text-text-secondary">
            Add Iris to your MCP config. First trace in 60 seconds. No SDK, no
            signup, no infrastructure.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <a
              href="https://github.com/iris-eval/mcp-server"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-xl bg-iris-600 px-8 py-4 text-[15px] font-semibold text-white shadow-lg shadow-iris-600/20 transition-all hover:bg-iris-500"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
              Try Iris
            </a>
            <a
              href="/#waitlist"
              className="inline-flex items-center rounded-xl border border-border-default px-8 py-4 text-[15px] font-semibold text-text-secondary transition-all hover:border-border-glow hover:text-text-primary"
            >
              Join Cloud Waitlist
            </a>
          </div>
        </div>
      </section>

      <Footer />
    </>
  );
}
