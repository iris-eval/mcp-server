import type { Metadata } from "next";
import { Nav } from "@/components/nav";
import { OG_IMAGE_URL } from "@/lib/og";
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
  title: "Iris vs DeepEval — MCP-Native Inline Eval vs Python Testing Framework",
  description:
    "Detailed comparison of Iris and DeepEval for AI agent evaluation. MCP-native inline scoring vs Python pytest-based test suites with LLM-as-Judge.",
  alternates: { canonical: "https://iris-eval.com/compare/deepeval" },
  openGraph: {
    title: "Iris vs DeepEval — MCP-Native Inline Eval vs Python Testing Framework",
    description:
      "Detailed comparison of Iris and DeepEval for AI agent evaluation. Inline scoring vs pytest-based test suites.",
    url: "https://iris-eval.com/compare/deepeval",
    images: [OG_IMAGE_URL],
  },
  twitter: {
    card: "summary_large_image",
    title: "Iris vs DeepEval — MCP-Native Inline Eval vs Python Testing Framework",
    description:
      "Detailed comparison of Iris and DeepEval. Inline scoring vs pytest-based test suites.",
    images: [OG_IMAGE_URL],
    site: "@iris_eval",
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      headline: sanitizeText("Iris vs DeepEval — MCP-Native Inline Eval vs Python Testing Framework"),
      description: sanitizeText(
        "Detailed comparison of Iris and DeepEval for AI agent evaluation. MCP-native inline scoring vs Python pytest-based test suites with LLM-as-Judge."
      ),
      url: "https://iris-eval.com/compare/deepeval",
      publisher: {
        "@type": "Organization",
        name: "Iris",
        url: "https://iris-eval.com",
      },
      mainEntityOfPage: "https://iris-eval.com/compare/deepeval",
    },
    {
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: sanitizeText("What is the difference between Iris and DeepEval?"),
          acceptedAnswer: {
            "@type": "Answer",
            text: sanitizeText(
              "Iris is an MCP-native eval server that scores every agent output inline in production. It ships both tracks: deterministic heuristic rules (millisecond, free) and LLM-as-Judge + semantic citation verification (semantic, cost-capped) as of v0.4. DeepEval is a Python testing framework that runs offline eval suites via pytest. Iris requires zero code changes and runs in real-time. DeepEval requires Python test files and runs as a batch testing step."
            ),
          },
        },
        {
          "@type": "Question",
          name: sanitizeText("Should I use Iris or DeepEval for agent evaluation?"),
          acceptedAnswer: {
            "@type": "Answer",
            text: sanitizeText(
              "Use Iris if you want inline production evaluation with zero setup — add one line to your MCP config and every agent output gets scored automatically, with both deterministic heuristics and LLM-as-Judge + citation verification available in the same tool surface. Use DeepEval if you're building in Python and want pytest-native eval workflows running offline in CI/CD."
            ),
          },
        },
      ],
    },
  ],
};

const FEATURES = [
  { feature: "Eval approach", iris: "Dual: deterministic rules (<1ms, free) + LLM-as-Judge (v0.4, 5 templates, cost-capped)", deepeval: "LLM-as-Judge metrics (semantic, slower)", irisWin: true },
  { feature: "Integration method", iris: "MCP config (zero code)", deepeval: "Python pytest decorators", irisWin: true },
  { feature: "When eval runs", iris: "Inline, every output in production", deepeval: "Offline, batch test suites in CI/CD", irisWin: true },
  { feature: "Language", iris: "TypeScript (any MCP agent)", deepeval: "Python only", irisWin: true },
  { feature: "Self-hosting", iris: "Single binary, one SQLite file", deepeval: "pip install, local execution", irisWin: false },
  { feature: "Built-in metrics", iris: "13 deterministic rules + 5 LLM-judge templates (accuracy, helpfulness, safety, correctness, faithfulness) + semantic citation verification", deepeval: "14+ metrics (faithfulness, hallucination, bias, toxicity)", irisWin: true },
  { feature: "Citation verification", iris: "SSRF-guarded source fetch + per-claim LLM verdict (v0.4)", deepeval: "Not included", irisWin: true },
  { feature: "Custom metrics", iris: "Zod schema custom rules + programmatic MCP deploy_rule", deepeval: "Python custom metrics class", irisNeutral: true },
  { feature: "Cost tracking", iris: "Per-trace USD cost + per-LLM-judge-eval cost + aggregate visibility", deepeval: "Not included", irisWin: true },
  { feature: "Dashboard", iris: "Real-time dark-mode UI with Decision Moments + drift detection", deepeval: "Confident AI cloud dashboard (separate product)", irisWin: true },
  { feature: "MCP support", iris: "Protocol-native (IS an MCP server; 9 tools)", deepeval: "Not MCP-aware", irisWin: true },
  { feature: "OpenTelemetry export", iris: "OTLP/HTTP JSON to Jaeger/Tempo/Datadog (v0.4)", deepeval: "Not included", irisWin: true },
  { feature: "Supply-chain integrity", iris: "SBOM + cosign + SLSA build-provenance (v0.4)", deepeval: "Standard pip", irisWin: true },
  { feature: "License", iris: "MIT", deepeval: "Apache 2.0", irisWin: false },
  { feature: "Maturity", iris: "Early stage (v0.4.0)", deepeval: "Established (14K+ GitHub stars)", deepevalWin: true, irisNeutral: true },
];

const IRIS_REASONS = [
  "You want eval running on every output in production, not just in test suites",
  "You're building with MCP-compatible agents and want zero-code integration",
  "You need cost tracking and aggregate spend visibility across agents",
  "You want a single self-hosted binary with no Python dependency",
  "You want both deterministic (fast, free) and LLM-as-Judge (semantic, cost-capped) in the same tool surface",
  "You need semantic citation verification — checking whether cited sources actually support the claim",
  "You want OpenTelemetry export to your existing Jaeger / Tempo / Datadog stack",
];

const DEEPEVAL_REASONS = [
  "You're building in Python and want pytest-native eval workflows",
  "You want to run eval suites in CI/CD pipelines before deployment",
  "You need a mature ecosystem with extensive documentation and community",
  "You want the Confident AI cloud platform for team collaboration",
];

export default function CompareDeepeval(): React.ReactElement {
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
            <span className="text-gradient">Iris</span> vs DeepEval
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-text-secondary">
            Inline production eval vs offline test suites.
            Two different philosophies for evaluating AI agent output.
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
            that scores every agent output inline in production — zero code
            changes, deterministic rules, sub-millisecond overhead.{" "}
            <strong className="text-text-primary">DeepEval</strong> is a Python
            testing framework that runs LLM-as-Judge evaluation suites via
            pytest — powerful semantic metrics, designed for CI/CD pipelines.
            If you want every production output scored automatically, Iris. If
            you want deep semantic evaluation in your test pipeline, DeepEval.
            <p className="mt-4 text-[13px] text-text-muted">
              For background on heuristic vs semantic evaluation, see our <a href="/blog/heuristic-vs-semantic-eval" className="text-iris-400 hover:text-iris-300 transition-colors">evaluation methodology guide</a>.
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
                  <th className="px-6 py-4 text-[12px] font-bold uppercase tracking-wider text-eval-pass">DeepEval</th>
                </tr>
              </thead>
              <tbody>
                {FEATURES.map((row) => (
                  <tr key={row.feature} className="border-b border-border-subtle last:border-b-0 transition-colors hover:bg-iris-600/[0.02]">
                    <td className="px-6 py-4 font-semibold text-text-primary whitespace-nowrap">{row.feature}</td>
                    <td className={`px-6 py-4 ${row.irisWin ? "font-medium text-text-accent" : row.irisNeutral ? "text-text-muted" : "text-text-secondary"}`}>
                      {row.iris}
                    </td>
                    <td className={`px-6 py-4 ${row.deepevalWin ? "font-medium text-eval-pass" : "text-text-secondary"}`}>
                      {row.deepeval}
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
              Which one fits your workflow?
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
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
                </span>
                When to choose DeepEval
              </h3>
              <ul className="space-y-3">
                {DEEPEVAL_REASONS.map((reason) => (
                  <li key={reason} className="relative pl-4 text-[14px] leading-relaxed text-text-secondary before:absolute before:left-0 before:top-[9px] before:h-[7px] before:w-[7px] before:rounded-full before:bg-eval-pass">
                    {reason}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <CompareDisclaimer lastVerified="March 2026" competitor="DeepEval" />

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
