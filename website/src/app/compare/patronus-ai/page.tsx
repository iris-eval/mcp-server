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
  title: "Iris vs Patronus AI — Open-Source Eval vs Enterprise Safety Platform",
  description:
    "Detailed comparison of Iris and Patronus AI for AI agent evaluation. Open-source MCP-native heuristic eval vs enterprise safety platform with fine-tuned eval models.",
  alternates: { canonical: "https://iris-eval.com/compare/patronus-ai" },
  openGraph: {
    title: "Iris vs Patronus AI — Open-Source Eval vs Enterprise Safety Platform",
    description:
      "Detailed comparison of Iris and Patronus AI. Open-source heuristic eval vs enterprise safety platform.",
    url: "https://iris-eval.com/compare/patronus-ai",
    images: [OG_IMAGE_URL],
  },
  twitter: {
    card: "summary_large_image",
    title: "Iris vs Patronus AI — Open-Source Eval vs Enterprise Safety Platform",
    description:
      "Detailed comparison of Iris and Patronus AI. Open-source eval vs enterprise safety platform.",
    images: [OG_IMAGE_URL],
    site: "@iris_eval",
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      headline: sanitizeText("Iris vs Patronus AI — Open-Source Eval vs Enterprise Safety Platform"),
      description: sanitizeText(
        "Detailed comparison of Iris and Patronus AI for AI agent evaluation. Open-source MCP-native heuristic eval vs enterprise safety platform with fine-tuned eval models."
      ),
      url: "https://iris-eval.com/compare/patronus-ai",
      publisher: {
        "@type": "Organization",
        name: "Iris",
        url: "https://iris-eval.com",
      },
      mainEntityOfPage: "https://iris-eval.com/compare/patronus-ai",
    },
    {
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: sanitizeText("What is the difference between Iris and Patronus AI?"),
          acceptedAnswer: {
            "@type": "Answer",
            text: sanitizeText(
              "Iris is an open-source MCP server that evaluates agent output using deterministic heuristic rules — PII detection, cost tracking, completeness scoring — inline in production. Patronus AI is an enterprise safety platform that uses fine-tuned evaluation models (Lynx, Glider) to detect hallucinations, toxicity, and safety violations. Iris is self-hosted and free. Patronus AI is a commercial API service."
            ),
          },
        },
        {
          "@type": "Question",
          name: sanitizeText("Is Iris or Patronus AI better for detecting hallucinations?"),
          acceptedAnswer: {
            "@type": "Answer",
            text: sanitizeText(
              "Patronus AI has purpose-built hallucination detection models (Lynx) that provide nuanced semantic analysis. Iris uses heuristic patterns to flag common hallucination markers — faster and cheaper but less nuanced. For high-stakes applications requiring deep semantic analysis, Patronus AI is stronger. For broad production coverage with minimal overhead, Iris provides a practical baseline."
            ),
          },
        },
      ],
    },
  ],
};

const FEATURES = [
  { feature: "Eval approach", iris: "Deterministic heuristic rules (<1ms)", patronus: "Fine-tuned eval models (Lynx, Glider)", patronusWin: true },
  { feature: "Integration method", iris: "MCP config (zero code)", patronus: "REST API + SDK", irisWin: true },
  { feature: "Deployment", iris: "Self-hosted (your infrastructure)", patronus: "Cloud API (vendor-hosted)", irisWin: true },
  { feature: "Hallucination detection", iris: "Heuristic pattern matching", patronus: "Purpose-built Lynx model", patronusWin: true },
  { feature: "Safety scoring", iris: "PII detection, prompt injection, blocklist", patronus: "Toxicity, bias, safety classifiers", patronusWin: true },
  { feature: "Cost tracking", iris: "Per-trace USD cost, aggregate visibility", patronus: "Not a primary feature", irisWin: true },
  { feature: "When eval runs", iris: "Inline, every output in production", patronus: "API call per evaluation request", irisWin: true },
  { feature: "MCP support", iris: "Protocol-native (IS an MCP server)", patronus: "Not MCP-aware", irisWin: true },
  { feature: "Pricing", iris: "Free and open-source (MIT)", patronus: "Enterprise pricing (contact sales)", irisWin: true },
  { feature: "Custom eval criteria", iris: "Zod schema custom rules", patronus: "Custom fine-tuned models", patronusWin: true },
  { feature: "Compliance", iris: "Self-hosted (you control data)", patronus: "SOC 2, enterprise security", patronusWin: true, irisNeutral: true },
  { feature: "Target audience", iris: "Individual developers, small teams", patronus: "Enterprise AI teams, regulated industries", irisWin: false },
];

const IRIS_REASONS = [
  "You want free, open-source eval with no vendor dependency",
  "You're building with MCP-compatible agents and want zero-code setup",
  "You need cost tracking and spend visibility across agents",
  "You want inline production eval on every output, not API calls per evaluation",
  "You want self-hosted data ownership with no cloud dependency",
];

const PATRONUS_REASONS = [
  "You need deep semantic hallucination detection with purpose-built models",
  "You're in a regulated industry requiring enterprise-grade safety scoring",
  "You need custom fine-tuned evaluation models for your specific domain",
  "You want managed infrastructure with SOC 2 compliance",
  "You need advanced toxicity and bias detection beyond heuristic rules",
];

export default function ComparePatronusAI(): React.ReactElement {
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
            <span className="text-gradient">Iris</span> vs Patronus AI
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-text-secondary">
            Open-source heuristic eval vs enterprise safety platform.
            Different tools for different stages and requirements.
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
            MCP server that scores every agent output with deterministic rules —
            PII detection, cost tracking, completeness, and relevance. Free and
            open-source.{" "}
            <strong className="text-text-primary">Patronus AI</strong> is an
            enterprise safety platform with fine-tuned evaluation models for
            hallucination detection, toxicity scoring, and custom safety
            criteria. If you want broad production coverage with zero overhead
            and zero cost, Iris. If you need deep semantic safety analysis for
            regulated or high-stakes deployments, Patronus AI.
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
                  <th className="px-6 py-4 text-[12px] font-bold uppercase tracking-wider text-eval-pass">Patronus AI</th>
                </tr>
              </thead>
              <tbody>
                {FEATURES.map((row) => (
                  <tr key={row.feature} className="border-b border-border-subtle last:border-b-0 transition-colors hover:bg-iris-600/[0.02]">
                    <td className="px-6 py-4 font-semibold text-text-primary whitespace-nowrap">{row.feature}</td>
                    <td className={`px-6 py-4 ${row.irisWin ? "font-medium text-text-accent" : row.irisNeutral ? "text-text-muted" : "text-text-secondary"}`}>
                      {row.iris}
                    </td>
                    <td className={`px-6 py-4 ${row.patronusWin ? "font-medium text-eval-pass" : "text-text-secondary"}`}>
                      {row.patronus}
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
              Which one fits your requirements?
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
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                </span>
                When to choose Patronus AI
              </h3>
              <ul className="space-y-3">
                {PATRONUS_REASONS.map((reason) => (
                  <li key={reason} className="relative pl-4 text-[14px] leading-relaxed text-text-secondary before:absolute before:left-0 before:top-[9px] before:h-[7px] before:w-[7px] before:rounded-full before:bg-eval-pass">
                    {reason}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <CompareDisclaimer lastVerified="March 2026" competitor="Patronus AI" />

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
