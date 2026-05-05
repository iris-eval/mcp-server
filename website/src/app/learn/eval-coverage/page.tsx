import type { Metadata } from "next";
import Link from "next/link";
import { OG_IMAGE_URL } from "@/lib/og";
import { SectionHeading } from "@/components/learn/section-heading";
import { CalloutBox } from "@/components/learn/callout-box";
import { VocabularyCard } from "@/components/learn/vocabulary-card";
import { FaqSection } from "@/components/learn/faq-section";
import { TableOfContents } from "@/components/learn/table-of-contents";

export const metadata: Metadata = {
  title: "Eval Coverage: The Metric Your AI Agents Are Missing — Iris",
  description: "What is eval coverage? The percentage of agent executions that receive evaluation. Most teams are at 0%. Here's why 100% is the only target.",
  alternates: { canonical: "https://iris-eval.com/learn/eval-coverage" },
  openGraph: { title: "Eval Coverage: The Metric Your AI Agents Are Missing", description: "The percentage of agent executions that receive evaluation.", url: "https://iris-eval.com/learn/eval-coverage", type: "article", images: [OG_IMAGE_URL] },
  twitter: { card: "summary_large_image", title: "Eval Coverage", description: "The percentage of agent executions that receive evaluation.", images: [OG_IMAGE_URL], site: "@iris_eval" },
};

function s(value: unknown): string { return String(value ?? "").replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").slice(0, 500); }

const FAQ_ITEMS = [
  { question: "What is eval coverage?", answer: "Eval coverage is the percentage of agent executions that receive automated evaluation. If your agent handles 1,000 requests and 50 are evaluated, your eval coverage is 5%. Most teams are at 0% — no outputs are scored at all." },
  { question: "Why does eval coverage matter?", answer: "Agents fail intermittently and silently. A 5% sample might miss every failure. The edge cases, drift events, and rare safety violations that matter most are exactly the ones sampling misses. 100% coverage means every output is scored — no blind spots." },
  { question: "How do you achieve 100% eval coverage?", answer: "By making evaluation zero-effort. If eval requires a pipeline, SDK integration, or manual setup, teams run it on samples or skip it entirely. Iris achieves 100% coverage by evaluating inline at the protocol layer — every output is scored automatically with no additional code." },
];

const TOC_ITEMS = [
  { id: "definition", label: "Definition", level: 2 as const },
  { id: "why-100-percent", label: "Why 100%", level: 2 as const },
  { id: "the-sampling-trap", label: "The Sampling Trap", level: 2 as const },
  { id: "how-iris-helps", label: "How Iris Helps", level: 2 as const },
  { id: "related-concepts", label: "Related Concepts", level: 2 as const },
  { id: "faq", label: "FAQ", level: 2 as const },
];

const jsonLd = { "@context": "https://schema.org", "@graph": [
  { "@type": "Article", headline: s("Eval Coverage: The Metric Your AI Agents Are Missing"), description: s("The percentage of agent executions that receive evaluation. Most teams are at 0%."), url: "https://iris-eval.com/learn/eval-coverage", datePublished: "2026-03-30", dateModified: "2026-03-30", author: { "@type": "Person", name: "Ian Parent", url: "https://x.com/iparentx" }, publisher: { "@type": "Organization", name: "Iris", url: "https://iris-eval.com" }, mainEntityOfPage: "https://iris-eval.com/learn/eval-coverage" },
  { "@type": "FAQPage", mainEntity: FAQ_ITEMS.map((item) => ({ "@type": "Question", name: s(item.question), acceptedAnswer: { "@type": "Answer", text: s(item.answer) } })) },
  { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: "https://iris-eval.com" }, { "@type": "ListItem", position: 2, name: "Learn", item: "https://iris-eval.com/learn" }, { "@type": "ListItem", position: 3, name: "Eval Coverage" }] },
]};

export default function LearnEvalCoverage(): React.ReactElement {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className="mx-auto max-w-6xl px-6 pt-32 pb-20 lg:pt-40">
        <div className="lg:grid lg:grid-cols-[1fr_240px] lg:gap-16">
        <article className="max-w-3xl text-[15px] leading-[1.8] text-text-secondary">
        <nav className="mb-8 text-sm text-text-muted">
          <Link href="/" className="hover:text-text-secondary transition-colors">Home</Link><span className="mx-2">/</span>
          <Link href="/learn" className="hover:text-text-secondary transition-colors">Learn</Link><span className="mx-2">/</span>
          <span className="text-text-primary">Eval Coverage</span>
        </nav>

        <h1 className="font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl">Eval Coverage</h1>
        <p className="mt-4 text-lg text-text-secondary max-w-2xl">The metric that tells you how much of your agent&apos;s output is actually being evaluated.</p>

        <SectionHeading id="definition" level={2}>Definition</SectionHeading>
        <CalloutBox variant="definition">
          <strong>Eval coverage</strong> is the percentage of agent executions that receive automated evaluation. An agent handling 1,000 requests with 50 evaluated has 5% coverage. Most teams are at 0%. The target is 100% — every output scored, every time.
        </CalloutBox>

        <SectionHeading id="why-100-percent" level={2}>Why 100% Is the Only Target</SectionHeading>
        <p className="mt-4 text-text-secondary leading-relaxed">
          In traditional software testing, 80% code coverage is considered good. In agent eval, anything less than 100% creates blind spots. The reason: agents fail intermittently and non-deterministically. The failure you care about most — a hallucinated answer, PII in an output, a cost spike — might happen on the one execution you didn&apos;t evaluate.
        </p>
        <CalloutBox variant="stat">
          Test coverage asks &quot;did we test this code path?&quot; Eval coverage asks &quot;did we score this output?&quot; The first is about code. The second is about every individual execution.
        </CalloutBox>

        <SectionHeading id="the-sampling-trap" level={2}>The Sampling Trap</SectionHeading>
        <p className="mt-4 text-text-secondary leading-relaxed">
          Some teams evaluate a sample of outputs — 1%, 5%, 10%. This feels reasonable but misses the point. Agent failures cluster in the long tail: unusual inputs, edge cases, specific user contexts. A random 5% sample is overwhelmingly likely to miss these. By definition, the failures that matter most are the ones that happen rarely — and sampling misses rare events.
        </p>

        <SectionHeading id="how-iris-helps" level={2}>How Iris Helps</SectionHeading>
        <p className="mt-4 text-text-secondary leading-relaxed">
          Iris achieves 100% eval coverage by design. Every output that flows through the MCP protocol gets scored — no sampling, no pipeline, no opt-in. The eval rules run in under one millisecond, so there&apos;s no performance reason to sample. Full coverage, zero overhead.
        </p>
        <p className="mt-6 text-text-secondary"><Link href="/blog/eval-coverage-the-metric-your-agents-are-missing" className="text-iris-400 hover:text-iris-300 transition-colors">Read the deep dive: Eval Coverage &rarr;</Link></p>

        <SectionHeading id="related-concepts" level={2}>Related Concepts</SectionHeading>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <VocabularyCard term="The Eval Tax" definition="0% coverage = maximum eval tax. Every unscored output adds to the balance." href="/learn/eval-tax" />
          <VocabularyCard term="Eval-Driven Development" definition="Define rules before prompts — coverage is built in from the start." href="/learn/eval-driven-development" />
          <VocabularyCard term="The Eval Loop" definition="Coverage is the foundation — you can't loop on what you don't measure." href="/learn/eval-loop" />
          <VocabularyCard term="Agent Eval" definition="The complete guide to evaluating AI agent outputs." href="/learn/agent-eval" />
        </div>

        <SectionHeading id="faq" level={2}>Frequently Asked Questions</SectionHeading>
        <FaqSection items={FAQ_ITEMS} />
        </article>
        <aside className="hidden lg:block">
          <TableOfContents items={TOC_ITEMS} />
        </aside>
        </div>
      </div>
    </>
  );
}
