import type { Metadata } from "next";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import { IrisLogo } from "@/components/iris-logo";
import { CompareDisclaimer } from "@/components/compare-disclaimer";

function sanitizeText(value: unknown): string {
  return String(value ?? "")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .slice(0, 500);
}

export const metadata: Metadata = {
  title: "Iris vs Confident AI — Self-Hosted Eval vs Managed LLM Testing Platform",
  description:
    "Detailed comparison of Iris and Confident AI for AI agent evaluation. Self-hosted MCP-native eval vs managed cloud platform with LLM-as-Judge and team collaboration.",
  alternates: { canonical: "https://iris-eval.com/compare/confident-ai" },
  openGraph: {
    title: "Iris vs Confident AI — Self-Hosted Eval vs Managed LLM Testing Platform",
    description:
      "Detailed comparison of Iris and Confident AI. Self-hosted MCP-native eval vs managed cloud testing platform.",
    url: "https://iris-eval.com/compare/confident-ai",
    images: ["/og-social-preview.png?v=3"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Iris vs Confident AI — Self-Hosted Eval vs Managed LLM Testing Platform",
    description:
      "Detailed comparison of Iris and Confident AI. Self-hosted eval vs managed cloud testing.",
    images: ["/og-social-preview.png?v=3"],
    site: "@iris_eval",
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      headline: sanitizeText("Iris vs Confident AI — Self-Hosted Eval vs Managed LLM Testing Platform"),
      description: sanitizeText(
        "Detailed comparison of Iris and Confident AI for AI agent evaluation. Self-hosted MCP-native eval vs managed cloud platform with LLM-as-Judge and team collaboration."
      ),
      url: "https://iris-eval.com/compare/confident-ai",
      publisher: {
        "@type": "Organization",
        name: "Iris",
        url: "https://iris-eval.com",
      },
      mainEntityOfPage: "https://iris-eval.com/compare/confident-ai",
    },
    {
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: sanitizeText("What is the difference between Iris and Confident AI?"),
          acceptedAnswer: {
            "@type": "Answer",
            text: sanitizeText(
              "Iris is a self-hosted MCP server that evaluates agent output inline in production using deterministic rules. Confident AI is a managed cloud platform built on top of DeepEval that provides LLM-as-Judge evaluation, team dashboards, regression testing, and dataset management. Iris is free and open-source. Confident AI is a commercial SaaS platform."
            ),
          },
        },
        {
          "@type": "Question",
          name: sanitizeText("Should I use Iris or Confident AI for my AI project?"),
          acceptedAnswer: {
            "@type": "Answer",
            text: sanitizeText(
              "Use Iris if you want self-hosted, zero-code eval running on every agent output in production with no vendor dependency. Use Confident AI if you need a managed platform with team collaboration, regression testing across experiments, and LLM-as-Judge evaluation with a visual dashboard for non-technical stakeholders."
            ),
          },
        },
      ],
    },
  ],
};

const FEATURES = [
  { feature: "Deployment", iris: "Self-hosted (your infrastructure)", confidentai: "Managed cloud (SaaS)", irisWin: true },
  { feature: "Integration method", iris: "MCP config (zero code)", confidentai: "Python SDK + API key", irisWin: true },
  { feature: "Eval approach", iris: "Deterministic heuristic rules (<1ms)", confidentai: "LLM-as-Judge metrics (semantic)", confidentaiWin: true },
  { feature: "When eval runs", iris: "Inline, every output in production", confidentai: "Batch experiments and CI/CD", irisWin: true },
  { feature: "Data ownership", iris: "100% local (SQLite, your machine)", confidentai: "Cloud-hosted (vendor manages)", irisWin: true },
  { feature: "Team collaboration", iris: "Single-user (team features on roadmap)", confidentai: "Multi-user dashboards, shared experiments", confidentaiWin: true, irisNeutral: true },
  { feature: "Regression testing", iris: "Not included", confidentai: "Built-in experiment comparison", confidentaiWin: true, irisNeutral: true },
  { feature: "Dataset management", iris: "Not included", confidentai: "Synthetic data generation, golden datasets", confidentaiWin: true, irisNeutral: true },
  { feature: "Cost tracking", iris: "Per-trace USD cost, aggregate visibility", confidentai: "Not a primary feature", irisWin: true },
  { feature: "MCP support", iris: "Protocol-native (IS an MCP server)", confidentai: "Not MCP-aware", irisWin: true },
  { feature: "Pricing", iris: "Free and open-source (MIT)", confidentai: "Free tier + paid plans", irisWin: true },
  { feature: "PII detection", iris: "Built-in (SSN, credit card, phone, email)", confidentai: "Via custom metrics or toxicity checks", irisWin: true },
];

const IRIS_REASONS = [
  "You want to own your eval data — no cloud dependency, no vendor lock-in",
  "You're building with MCP-compatible agents and want zero-code setup",
  "You want inline production eval, not just pre-deployment testing",
  "You need cost tracking and PII detection out of the box",
  "You want fully open-source with no usage limits",
];

const CONFIDENTAI_REASONS = [
  "You need team collaboration with shared dashboards and experiments",
  "You want LLM-as-Judge evaluation for nuanced semantic scoring",
  "You need regression testing to compare model versions",
  "You want synthetic dataset generation for comprehensive test coverage",
  "You prefer a managed platform without infrastructure overhead",
];

export default function CompareConfidentAI(): React.ReactElement {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Nav />

      {/* Hero */}
      <section className="relative overflow-hidden bg-bg-base pb-12 pt-32 text-center lg:pt-40">
        <div className="glow-hero absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-30" aria-hidden="true" />
        <div className="relative mx-auto max-w-4xl px-6">
          <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-text-accent">
            Comparison
          </p>
          <h1 className="mt-4 font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl lg:text-6xl">
            <span className="text-gradient">Iris</span> vs Confident AI
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-text-secondary">
            Self-hosted inline eval vs managed cloud testing platform.
            Own your data or outsource the infrastructure.
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
            <strong className="text-text-primary">Iris</strong> is a self-hosted
            MCP server that evaluates every agent output inline in production —
            your data stays on your machine, no API keys needed.{" "}
            <strong className="text-text-primary">Confident AI</strong> is the
            commercial cloud platform built on top of DeepEval, offering
            LLM-as-Judge evaluation, team dashboards, regression testing, and
            dataset management. If you want zero-vendor-dependency eval that
            runs on every output, Iris. If you need a managed platform with
            team collaboration and semantic evaluation, Confident AI.
            <p className="mt-4 text-[13px] text-text-muted">
              For background on agent evaluation methodology, see our <a href="/learn/agent-eval" className="text-iris-400 hover:text-iris-300 transition-colors">agent eval guide</a>.
            </p>
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
                  <th className="px-6 py-4 text-[12px] font-bold uppercase tracking-wider text-eval-pass">Confident AI</th>
                </tr>
              </thead>
              <tbody>
                {FEATURES.map((row) => (
                  <tr key={row.feature} className="border-b border-border-subtle last:border-b-0 transition-colors hover:bg-iris-600/[0.02]">
                    <td className="px-6 py-4 font-semibold text-text-primary whitespace-nowrap">{row.feature}</td>
                    <td className={`px-6 py-4 ${row.irisWin ? "font-medium text-text-accent" : row.irisNeutral ? "text-text-muted" : "text-text-secondary"}`}>
                      {row.iris}
                    </td>
                    <td className={`px-6 py-4 ${row.confidentaiWin ? "font-medium text-eval-pass" : "text-text-secondary"}`}>
                      {row.confidentai}
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
              Which one fits your team?
            </h2>
          </div>
          <div className="grid gap-8 md:grid-cols-2">
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
            <div className="rounded-2xl border border-border-default bg-bg-card p-8 transition-colors hover:border-border-glow">
              <h3 className="mb-6 flex items-center gap-3 font-display text-xl font-bold text-text-primary">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-eval-pass/30 bg-eval-pass/10">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                </span>
                When to choose Confident AI
              </h3>
              <ul className="space-y-3">
                {CONFIDENTAI_REASONS.map((reason) => (
                  <li key={reason} className="relative pl-4 text-[14px] leading-relaxed text-text-secondary before:absolute before:left-0 before:top-[9px] before:h-[7px] before:w-[7px] before:rounded-full before:bg-eval-pass">
                    {reason}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <CompareDisclaimer lastVerified="March 2026" competitor="Confident AI" />

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
