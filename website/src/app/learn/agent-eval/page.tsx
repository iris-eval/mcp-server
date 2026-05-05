import type { Metadata } from "next";
import Link from "next/link";
import { OG_IMAGE_URL } from "@/lib/og";
import { SectionHeading } from "@/components/learn/section-heading";
import { CalloutBox } from "@/components/learn/callout-box";
import { VocabularyCard } from "@/components/learn/vocabulary-card";
import { ThreeLayerDiagram } from "@/components/learn/three-layer-diagram";
import { FaqSection } from "@/components/learn/faq-section";
import { TableOfContents } from "@/components/learn/table-of-contents";

/* ------------------------------------------------------------------ */
/*  Metadata                                                          */
/* ------------------------------------------------------------------ */

export const metadata: Metadata = {
  title: "Agent Eval: The Definitive Guide to AI Agent Evaluation — Iris",
  description:
    "What is agent eval? The complete guide to evaluating AI agent outputs for quality, safety, and cost. Covers heuristic vs. semantic eval, eval-driven development, the eval loop, and practical implementation.",
  alternates: { canonical: "https://iris-eval.com/learn/agent-eval" },
  openGraph: {
    title: "Agent Eval: The Definitive Guide to AI Agent Evaluation",
    description:
      "The complete reference for evaluating AI agent outputs. Methodologies, implementation patterns, and code examples.",
    url: "https://iris-eval.com/learn/agent-eval",
    type: "article",
    images: [OG_IMAGE_URL],
  },
  twitter: {
    card: "summary_large_image",
    title: "Agent Eval: The Definitive Guide to AI Agent Evaluation",
    description:
      "The complete reference for evaluating AI agent outputs. Methodologies, implementation, code examples.",
    images: [OG_IMAGE_URL],
    site: "@iris_eval",
  },
};

/* ------------------------------------------------------------------ */
/*  Structured Data                                                    */
/* ------------------------------------------------------------------ */

function s(value: unknown): string {
  return String(value ?? "")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .slice(0, 500);
}

const FAQ_ITEMS = [
  {
    question: "What is agent eval?",
    answer:
      "Agent eval is the systematic scoring of every output produced by an AI agent for quality, safety, and cost. Unlike infrastructure monitoring that tells you a request succeeded, agent eval tells you whether the output was actually correct, safe, and cost-efficient.",
    link: { label: "Read: Why agents need eval", href: "/blog/why-your-ai-agents-need-observability" },
  },
  {
    question: "What is the difference between agent eval and model benchmarking?",
    answer:
      "Model benchmarking tests a model's capabilities before deployment using standardized datasets. Agent eval scores real production outputs on every execution. Benchmarking answers 'can this model do the task?' while agent eval answers 'did this agent do the task correctly right now?'",
  },
  {
    question: "Do I need LLM-as-Judge to evaluate agent outputs?",
    answer:
      "Not necessarily. Heuristic evaluation uses deterministic rules (pattern matching, threshold checks, PII regex) that run in under one millisecond with zero cost and perfect consistency. LLM-as-Judge is useful for assessing subjective quality, but many production use cases are fully covered by heuristic rules.",
    link: { label: "Read: Heuristic vs Semantic Eval", href: "/blog/heuristic-vs-semantic-eval" },
  },
  {
    question: "How often should I evaluate agent outputs?",
    answer:
      "Every execution. The goal is 100% eval coverage — scoring every output, not sampling. Agents fail intermittently and silently. Sampling-based evaluation misses the exact failures that matter most: edge cases, drift, and rare but catastrophic safety violations.",
    link: { label: "Read: Eval Coverage", href: "/blog/eval-coverage-the-metric-your-agents-are-missing" },
  },
  {
    question: "What is eval drift?",
    answer:
      "Eval drift is the silent degradation of agent output quality over time, even when your code and prompts haven't changed. It's caused by upstream model updates, shifting input distributions, and environmental changes. Without continuous evaluation, drift goes undetected until users report failures.",
    link: { label: "Read: Eval Drift", href: "/blog/eval-drift-the-silent-quality-killer" },
  },
  {
    question: "What is eval-driven development?",
    answer:
      "Eval-driven development (EDD) is the practice of defining evaluation rules before writing agent prompts — the same way test-driven development defines tests before writing code. You specify what 'correct' looks like first, then build the agent to pass those rules.",
    link: { label: "Read: Eval-Driven Development", href: "/blog/eval-driven-development" },
  },
  {
    question: "How does agent eval differ from traditional software testing?",
    answer:
      "Traditional testing verifies deterministic behavior: given input X, expect output Y. Agent outputs are non-deterministic — the same input can produce different outputs across runs. Agent eval uses scoring rules (quality thresholds, safety patterns, cost limits) instead of exact-match assertions.",
  },
  {
    question: "What is the eval tax?",
    answer:
      "The eval tax is the compounding cost of every unscored agent output — measured in trust erosion, engineering hours spent on manual review, and liability exposure. Teams without agent eval pay this tax on every execution, whether they realize it or not.",
    link: { label: "Read: The AI Eval Tax", href: "/blog/the-ai-eval-tax" },
  },
];

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      headline: s("Agent Eval: The Definitive Guide to AI Agent Evaluation"),
      description: s(
        "The complete guide to evaluating AI agent outputs for quality, safety, and cost.",
      ),
      url: "https://iris-eval.com/learn/agent-eval",
      datePublished: "2026-03-28",
      dateModified: "2026-03-28",
      author: {
        "@type": "Person",
        name: "Ian Parent",
        url: "https://x.com/iparentx",
      },
      publisher: {
        "@type": "Organization",
        name: "Iris",
        url: "https://iris-eval.com",
      },
      mainEntityOfPage: "https://iris-eval.com/learn/agent-eval",
      about: {
        "@type": "Thing",
        name: "AI Agent Evaluation",
        description: s(
          "The systematic scoring of AI agent outputs for quality, safety, and cost",
        ),
      },
    },
    {
      "@type": "FAQPage",
      mainEntity: FAQ_ITEMS.map((item) => ({
        "@type": "Question",
        name: s(item.question),
        acceptedAnswer: {
          "@type": "Answer",
          text: s(item.answer),
        },
      })),
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Home",
          item: "https://iris-eval.com",
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "Learn",
          item: "https://iris-eval.com/learn",
        },
        {
          "@type": "ListItem",
          position: 3,
          name: "Agent Eval",
        },
      ],
    },
  ],
};

/* ------------------------------------------------------------------ */
/*  TOC Data                                                           */
/* ------------------------------------------------------------------ */

const TOC_ITEMS = [
  { id: "what-is-agent-eval", label: "What Is Agent Eval?", level: 2 as const },
  { id: "why-agent-eval-matters", label: "Why It Matters", level: 2 as const },
  { id: "cost-of-not-evaluating", label: "The Cost of Not Evaluating", level: 3 as const },
  { id: "silent-degradation", label: "Silent Degradation", level: 3 as const },
  { id: "production-gap", label: "The Production Gap", level: 3 as const },
  { id: "three-layer-model", label: "The Three-Layer Model", level: 2 as const },
  { id: "eval-methodologies", label: "Eval Methodologies", level: 2 as const },
  { id: "heuristic-eval", label: "Heuristic Eval", level: 3 as const },
  { id: "semantic-eval", label: "Semantic Eval (LLM-as-Judge)", level: 3 as const },
  { id: "hybrid-approach", label: "Hybrid Approach", level: 3 as const },
  { id: "what-to-evaluate", label: "What to Evaluate", level: 2 as const },
  { id: "eval-driven-development", label: "Eval-Driven Development", level: 2 as const },
  { id: "the-eval-loop", label: "The Eval Loop", level: 2 as const },
  { id: "getting-started", label: "Getting Started", level: 2 as const },
  { id: "faq", label: "FAQ", level: 2 as const },
  { id: "references", label: "References", level: 2 as const },
];

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function AgentEvalGuide(): React.ReactElement {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Hero */}
      <section className="relative bg-bg-base pb-12 pt-32 lg:pt-40">
        <div className="glow-hero absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 opacity-30" aria-hidden="true" />
        <div className="relative mx-auto max-w-4xl px-6 text-center">
          <nav aria-label="Breadcrumb" className="mb-6 flex items-center justify-center gap-1.5 text-[12px] text-text-muted">
            <Link href="/" className="hover:text-text-secondary transition-colors">Home</Link>
            <span>/</span>
            <Link href="/learn" className="hover:text-text-secondary transition-colors">Learn</Link>
            <span>/</span>
            <span className="text-text-secondary">Agent Eval</span>
          </nav>
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-iris-400">
            Definitive Guide
          </p>
          <h1 className="mt-4 font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl lg:text-[56px] lg:leading-[1.1]">
            Agent Eval
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-text-secondary md:text-xl">
            The complete guide to evaluating AI agent outputs for quality,
            safety, and cost. From fundamentals to implementation.
          </p>
          <p className="mt-4 text-[13px] text-text-muted">
            By{" "}
            <a href="https://x.com/iparentx" target="_blank" rel="noopener noreferrer" className="text-text-secondary hover:text-iris-400 transition-colors">
              Ian Parent
            </a>
            {" "}&middot; Last updated March 2026 &middot; 15 min read
          </p>
        </div>
      </section>

      {/* Content */}
      <section className="bg-bg-base pb-24">
        <div className="mx-auto max-w-6xl px-6">
          <div className="lg:grid lg:grid-cols-[1fr_240px] lg:gap-16">
            {/* Main content */}
            <article className="max-w-3xl text-[15px] leading-[1.8] text-text-secondary">

              {/* ---- Section 1: What Is Agent Eval? ---- */}
              <SectionHeading id="what-is-agent-eval">
                What Is Agent Eval?
              </SectionHeading>

              <CalloutBox variant="definition">
                <strong>Agent eval</strong> is the systematic scoring of every
                output produced by an AI agent for quality, safety, and cost. It
                answers the question that infrastructure monitoring cannot:{" "}
                <em>was the output actually correct?</em>
              </CalloutBox>

              <p>
                When an AI agent processes a request, traditional monitoring tells you the request
                completed. It tells you the latency, the status code, the resource consumption. What
                it does not tell you is whether the agent&apos;s response was accurate, safe, and worth
                what it cost.
              </p>

              <p className="mt-4">
                Agent eval fills this gap. It runs <strong>inline on every execution</strong> in
                production — not as a one-time pre-deployment gate, not as an offline batch job, but
                as a continuous quality layer that scores every output the moment it is produced.
              </p>

              <p className="mt-4">
                This is different from adjacent practices that are often confused with agent eval:
              </p>

              <ul className="mt-4 space-y-2 pl-5 list-disc marker:text-iris-500/50">
                <li>
                  <strong>Model benchmarking</strong> tests capabilities before deployment using
                  standardized datasets. Agent eval scores real outputs in production.
                </li>
                <li>
                  <strong>Prompt engineering</strong> optimizes instructions at development time.
                  Agent eval verifies those instructions produce correct results at runtime.
                </li>
                <li>
                  <strong>Infrastructure monitoring</strong> (APM) tracks whether systems are
                  running. Agent eval tracks whether outputs are{" "}
                  <Link href="/blog/the-eval-gap" className="text-iris-400 hover:text-iris-300 transition-colors">good</Link>.
                </li>
              </ul>

              <p className="mt-4">
                The distinction matters because agents fail in ways traditional systems do not. They
                produce outputs that look correct but contain fabricated facts. They leak personally
                identifiable information. They silently degrade when upstream models change. These
                failure modes require evaluation at the{" "}
                <Link href="/blog/why-your-ai-agents-need-observability" className="text-iris-400 hover:text-iris-300 transition-colors">
                  output layer
                </Link>
                , not the infrastructure layer.
              </p>

              {/* ---- Section 2: Why Agent Eval Matters ---- */}
              <SectionHeading id="why-agent-eval-matters">
                Why Agent Eval Matters
              </SectionHeading>

              <SectionHeading id="cost-of-not-evaluating" level={3}>
                The Cost of Not Evaluating
              </SectionHeading>

              <CalloutBox variant="stat" title="Industry Data">
                AI hallucinations caused an estimated <strong>$67.4 billion</strong> in
                global financial losses in 2024. AI safety incidents surged{" "}
                <strong>56.4%</strong> year-over-year according to the Stanford AI Index.
              </CalloutBox>

              <p>
                Every unscored agent output carries a cost — in trust, in engineering hours, and in
                liability. This is the{" "}
                <Link href="/blog/the-ai-eval-tax" className="text-iris-400 hover:text-iris-300 transition-colors font-medium">
                  eval tax
                </Link>
                : the compounding price teams pay for operating agents without systematic evaluation.
                The longer an agent runs unevaluated, the higher the accumulated risk.
              </p>

              <VocabularyCard
                term="The Eval Tax"
                definition="The compounding cost of every unscored agent output — in trust, engineering hours, and liability."
                href="/learn/eval-tax"
              />

              <SectionHeading id="silent-degradation" level={3}>
                Silent Degradation
              </SectionHeading>

              <p>
                Agent quality degrades without any code changes. Upstream model providers update their
                models without notice — a study by Stanford and Berkeley found that GPT-4&apos;s code
                generation accuracy dropped from 52% to 10% between March and June 2023 with no
                changelog entry. Research shows 91% of machine learning models experience performance
                degradation over time.
              </p>

              <p className="mt-4">
                This phenomenon is{" "}
                <Link href="/blog/eval-drift-the-silent-quality-killer" className="text-iris-400 hover:text-iris-300 transition-colors font-medium">
                  eval drift
                </Link>
                : the silent erosion of output quality driven by provider updates, shifting input
                distributions, and environmental changes. Without continuous evaluation, drift goes
                undetected until users report failures.
              </p>

              <VocabularyCard
                term="Eval Drift"
                definition="Silent degradation of agent output quality over time — even when your code and prompts haven't changed."
                href="/learn/eval-drift"
              />

              <SectionHeading id="production-gap" level={3}>
                The Production Gap
              </SectionHeading>

              <CalloutBox variant="stat" title="Industry Data">
                Gartner projects <strong>40%</strong> of agentic AI projects will be
                canceled by end of 2027. A LangChain survey found only{" "}
                <strong>37%</strong> of teams run evaluations on production traffic.
              </CalloutBox>

              <p>
                The distance between &ldquo;the demo works&rdquo; and &ldquo;production works&rdquo;
                is the{" "}
                <Link href="/blog/the-eval-gap" className="text-iris-400 hover:text-iris-300 transition-colors font-medium">
                  eval gap
                </Link>
                . Demos operate on curated inputs with forgiving audiences. Production operates on
                adversarial inputs at scale with real consequences. Agent eval is the bridge between
                the two.
              </p>

              <VocabularyCard
                term="The Eval Gap"
                definition="The distance between 'demo works' and 'production works' — driven by input distribution, compound failure, and cost reality."
                href="/learn/eval-gap"
              />

              {/* ---- Section 3: Three-Layer Model ---- */}
              <SectionHeading id="three-layer-model">
                Where Agent Eval Fits: The Three-Layer Model
              </SectionHeading>

              <p>
                Agent systems require three distinct layers of observability. Most teams have
                infrastructure monitoring. Emerging teams add protocol-level tracing. The layer that
                almost everyone is missing is output quality evaluation.
              </p>

              <ThreeLayerDiagram />

              <p>
                Each layer answers a different question. Infrastructure monitoring tells you the
                server is up. Protocol monitoring tells you the MCP calls completed. Agent eval tells
                you whether the response was actually correct, safe, and worth what it cost. These
                layers are complementary —{" "}
                <Link href="/blog/mcp-observability-is-the-new-apm" className="text-iris-400 hover:text-iris-300 transition-colors">
                  you need all three
                </Link>
                .
              </p>

              {/* ---- Section 4: Eval Methodologies ---- */}
              <SectionHeading id="eval-methodologies">
                Agent Eval Methodologies
              </SectionHeading>

              <p>
                There are two fundamental approaches to evaluating agent outputs, each with distinct
                tradeoffs. Most production systems benefit from combining both.
              </p>

              <SectionHeading id="heuristic-eval" level={3}>
                Heuristic Eval
              </SectionHeading>

              <p>
                Heuristic evaluation uses deterministic, pattern-based rules to score agent outputs.
                These rules are fast (sub-millisecond), free (no API calls), and perfectly consistent —
                the same input always produces the same score.
              </p>

              <p className="mt-4">Common heuristic eval rules include:</p>
              <ul className="mt-3 space-y-1.5 pl-5 list-disc marker:text-iris-500/50">
                <li><strong>PII detection</strong> — regex patterns for SSN, credit card, phone, email</li>
                <li><strong>Prompt injection detection</strong> — patterns that indicate the agent is being manipulated</li>
                <li><strong>Output length thresholds</strong> — responses that are suspiciously short or long</li>
                <li><strong>Cost limits</strong> — token usage and execution cost exceeding budgets</li>
                <li><strong>Blocklist enforcement</strong> — prohibited words, competitor names, harmful content</li>
              </ul>

              <SectionHeading id="semantic-eval" level={3}>
                Semantic Eval (LLM-as-Judge)
              </SectionHeading>

              <p>
                Semantic evaluation uses a language model to assess the meaning and quality of agent
                outputs. An LLM scores responses against a rubric — checking for factual accuracy,
                coherence, helpfulness, and relevance.
              </p>

              <p className="mt-4">
                The tradeoffs are real: semantic eval is slower (seconds, not milliseconds), costs
                money (each evaluation is an API call), and introduces non-determinism (the judge
                model can produce different scores for the same input). It also creates a recursive
                trust problem:{" "}
                <Link href="/blog/heuristic-vs-semantic-eval" className="text-iris-400 hover:text-iris-300 transition-colors">
                  who evaluates the evaluator?
                </Link>
              </p>

              <SectionHeading id="hybrid-approach" level={3}>
                Hybrid Approach
              </SectionHeading>

              <p>
                The most effective production systems use both. Heuristic rules handle safety gates
                (PII, injection, cost) — these are non-negotiable, binary checks that must run on
                every execution at zero latency. Semantic eval handles quality assessment for a
                subset of outputs where subjective judgment matters. This layered approach gives you
                full coverage without the cost of running LLM-as-Judge on every request.
              </p>

              <p className="mt-4">
                For a deep comparison of these approaches, see{" "}
                <Link href="/blog/how-to-evaluate-agent-output-without-llm" className="text-iris-400 hover:text-iris-300 transition-colors">
                  How to Evaluate Agent Output Without Calling Another LLM
                </Link>
                .
              </p>

              {/* ---- Section 5: What to Evaluate ---- */}
              <SectionHeading id="what-to-evaluate">
                What to Evaluate: The Four Categories
              </SectionHeading>

              <p>
                Agent eval rules typically fall into four categories. A comprehensive evaluation
                system covers all four, targeting{" "}
                <Link href="/blog/eval-coverage-the-metric-your-agents-are-missing" className="text-iris-400 hover:text-iris-300 transition-colors font-medium">
                  100% eval coverage
                </Link>{" "}
                — scoring every execution, not sampling.
              </p>

              <div className="mt-8 grid gap-4 sm:grid-cols-2">
                {[
                  {
                    name: "Completeness",
                    desc: "Did the response address the full request? Topic consistency, expected elements, response coverage.",
                    color: "border-emerald-500/30 bg-emerald-500/5",
                  },
                  {
                    name: "Relevance",
                    desc: "Is the response appropriate? Language match, format validation, sentiment alignment.",
                    color: "border-blue-500/30 bg-blue-500/5",
                  },
                  {
                    name: "Safety",
                    desc: "Is the response safe to deliver? PII detection, hallucination markers, injection patterns, blocklist.",
                    color: "border-red-500/30 bg-red-500/5",
                  },
                  {
                    name: "Cost",
                    desc: "Was the response worth the resources? Token usage, execution cost, latency thresholds.",
                    color: "border-amber-500/30 bg-amber-500/5",
                  },
                ].map((cat) => (
                  <div
                    key={cat.name}
                    className={`rounded-xl border ${cat.color} px-5 py-4`}
                  >
                    <p className="font-display text-[15px] font-bold text-text-primary">
                      {cat.name}
                    </p>
                    <p className="mt-1 text-[13px] leading-relaxed text-text-muted">
                      {cat.desc}
                    </p>
                  </div>
                ))}
              </div>

              <VocabularyCard
                term="Eval Coverage"
                definition="The percentage of agent executions that receive evaluation. The target is 100% — every output scored, not sampled."
                href="/learn/eval-coverage"
              />

              {/* ---- Section 6: Eval-Driven Development ---- */}
              <SectionHeading id="eval-driven-development">
                Eval-Driven Development
              </SectionHeading>

              <p>
                Test-driven development (TDD) changed how software teams write code: define the test
                first, then write the implementation. Research from IBM and Microsoft found that TDD
                reduces production defects by 40-90%.
              </p>

              <p className="mt-4">
                <Link href="/blog/eval-driven-development" className="text-iris-400 hover:text-iris-300 transition-colors font-medium">
                  Eval-driven development (EDD)
                </Link>{" "}
                applies the same discipline to AI agents. Define what &ldquo;correct&rdquo; looks like
                before writing the prompt. The workflow:
              </p>

              <ol className="mt-4 space-y-2 pl-5 list-decimal marker:text-text-muted marker:font-mono">
                <li><strong>Define rules</strong> — specify eval criteria for quality, safety, and cost</li>
                <li><strong>Write prompt</strong> — build the agent with rules as the quality contract</li>
                <li><strong>Run eval</strong> — score real outputs against the rules</li>
                <li><strong>Iterate</strong> — adjust prompts, tools, or architecture based on scores</li>
                <li><strong>Lock rules</strong> — once passing, rules become the regression suite</li>
              </ol>

              <VocabularyCard
                term="Eval-Driven Development (EDD)"
                definition="Define evaluation rules before writing agent prompts — the same way TDD defines tests before writing code."
                href="/learn/eval-driven-development"
              />

              {/* ---- Section 7: The Eval Loop ---- */}
              <SectionHeading id="the-eval-loop">
                The Eval Loop: Continuous Quality
              </SectionHeading>

              <p>
                Agent evaluation is not a one-time event. Models change, inputs drift, and thresholds
                that made sense last month may not make sense today. The{" "}
                <Link href="/blog/the-eval-loop" className="text-iris-400 hover:text-iris-300 transition-colors font-medium">
                  eval loop
                </Link>{" "}
                is the continuous cycle that keeps evaluation calibrated:
              </p>

              <div className="my-8 flex flex-wrap items-center justify-center gap-3 text-[14px] font-medium">
                {["Score", "Diagnose", "Calibrate", "Re-score"].map((step, i) => (
                  <span key={step} className="flex items-center gap-3">
                    <span className="rounded-lg border border-border-default bg-bg-card px-4 py-2 text-text-primary">
                      {step}
                    </span>
                    {i < 3 && (
                      <svg className="h-4 w-4 text-iris-500" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 8h10M9 4l4 4-4 4" />
                      </svg>
                    )}
                  </span>
                ))}
                <svg className="h-4 w-4 text-text-muted rotate-180" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 8h10M9 4l4 4-4 4" />
                </svg>
              </div>

              <p>
                Advanced systems implement{" "}
                <Link href="/blog/self-calibrating-eval" className="text-iris-400 hover:text-iris-300 transition-colors font-medium">
                  self-calibrating evaluation
                </Link>
                : the system monitors its own scoring distributions and recommends threshold
                adjustments when the environment shifts. This closes the loop automatically,
                reducing the manual burden of maintaining eval rules over time.
              </p>

              {/* ---- Section 8: Getting Started ---- */}
              <SectionHeading id="getting-started">
                Getting Started
              </SectionHeading>

              <p>
                Iris is the agent eval standard for MCP. Any MCP-compatible agent can discover and
                use it automatically — no SDK, no code changes. Add it to your MCP configuration:
              </p>

              <pre className="my-6 overflow-x-auto rounded-xl border border-border-default bg-bg-card p-5 font-mono text-[13px] leading-relaxed text-text-secondary">
{`{
  "mcpServers": {
    "iris": {
      "command": "npx",
      "args": ["-y", "@iris-eval/mcp-server"]
    }
  }
}`}
              </pre>

              <p>
                Iris provides nine MCP tools — full lifecycle plus semantic eval. Core: <code className="rounded bg-bg-card px-1.5 py-0.5 font-mono text-[13px] text-iris-400">log_trace</code> for recording agent executions, <code className="rounded bg-bg-card px-1.5 py-0.5 font-mono text-[13px] text-iris-400">evaluate_output</code> for scoring outputs against 13 built-in eval rules, and <code className="rounded bg-bg-card px-1.5 py-0.5 font-mono text-[13px] text-iris-400">get_traces</code> for querying historical data. Lifecycle: <code className="rounded bg-bg-card px-1.5 py-0.5 font-mono text-[13px] text-iris-400">list_rules</code> / <code className="rounded bg-bg-card px-1.5 py-0.5 font-mono text-[13px] text-iris-400">deploy_rule</code> / <code className="rounded bg-bg-card px-1.5 py-0.5 font-mono text-[13px] text-iris-400">delete_rule</code> / <code className="rounded bg-bg-card px-1.5 py-0.5 font-mono text-[13px] text-iris-400">delete_trace</code>. Semantic: <code className="rounded bg-bg-card px-1.5 py-0.5 font-mono text-[13px] text-iris-400">evaluate_with_llm_judge</code> (5 templates, cost-capped) and <code className="rounded bg-bg-card px-1.5 py-0.5 font-mono text-[13px] text-iris-400">verify_citations</code> (SSRF-guarded source fetch + per-claim verdict).
              </p>

              <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                <Link
                  href="/playground"
                  className="inline-flex items-center justify-center rounded-xl bg-iris-600 px-6 py-3 text-[14px] font-semibold text-white shadow-lg shadow-iris-600/20 transition-all hover:bg-iris-500"
                >
                  Try the Playground
                </Link>
                <a
                  href="https://github.com/iris-eval/mcp-server"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center rounded-xl border border-border-default px-6 py-3 text-[14px] font-semibold text-text-secondary transition-all hover:border-border-glow hover:text-text-primary"
                >
                  View on GitHub
                </a>
              </div>

              {/* ---- Section 9: FAQ ---- */}
              <SectionHeading id="faq">
                Frequently Asked Questions
              </SectionHeading>

              <FaqSection items={FAQ_ITEMS} />

              {/* ---- Section 10: References ---- */}
              <SectionHeading id="references">
                References
              </SectionHeading>

              <ul className="space-y-2 text-[13px] text-text-muted">
                <li>Stanford AI Index Report 2025 — AI safety incident trends, global adoption metrics</li>
                <li>Chen, L. et al. (2023) &ldquo;How Is ChatGPT&apos;s Behavior Changing over Time?&rdquo; — Stanford/Berkeley GPT-4 drift study (arXiv:2307.09009)</li>
                <li>IBM/Microsoft joint study — Test-driven development reduces production defects 40-90%</li>
                <li>Gartner (2025) — 40% of agentic AI projects projected to be canceled by 2027</li>
                <li>LangChain State of AI Agents (2025) — Production evaluation adoption rates</li>
                <li>EU AI Act — Article 14 human oversight requirements, effective August 2026</li>
              </ul>

              <p className="mt-8 text-[13px] text-text-muted">
                Last updated March 2026. This guide is maintained by the Iris team and
                updated as the agent eval landscape evolves.
              </p>
            </article>

            {/* Sidebar TOC */}
            <aside className="hidden lg:block">
              <TableOfContents items={TOC_ITEMS} />
            </aside>
          </div>
        </div>
      </section>
    </>
  );
}
