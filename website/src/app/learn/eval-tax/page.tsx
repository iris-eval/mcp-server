import type { Metadata } from "next";
import Link from "next/link";
import { OG_IMAGE_URL } from "@/lib/og";
import { SectionHeading } from "@/components/learn/section-heading";
import { CalloutBox } from "@/components/learn/callout-box";
import { VocabularyCard } from "@/components/learn/vocabulary-card";
import { FaqSection } from "@/components/learn/faq-section";
import { TableOfContents } from "@/components/learn/table-of-contents";

export const metadata: Metadata = {
  title: "The Eval Tax: The Hidden Cost of Not Evaluating — Iris",
  description:
    "What is the eval tax? The compounding cost of every unscored agent output — in trust, engineering hours, and liability. Learn how to stop paying it.",
  alternates: { canonical: "https://iris-eval.com/learn/eval-tax" },
  openGraph: {
    title: "The Eval Tax: The Hidden Cost of Not Evaluating",
    description: "The compounding cost of every unscored agent output.",
    url: "https://iris-eval.com/learn/eval-tax",
    type: "article",
    images: [OG_IMAGE_URL],
  },
  twitter: {
    card: "summary_large_image",
    title: "The Eval Tax: The Hidden Cost of Not Evaluating",
    description: "The compounding cost of every unscored agent output.",
    images: [OG_IMAGE_URL],
    site: "@iris_eval",
  },
};

function s(value: unknown): string {
  return String(value ?? "").replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").slice(0, 500);
}

const FAQ_ITEMS = [
  {
    question: "What is the eval tax?",
    answer: "The eval tax is the compounding cost of every unscored agent output — measured in trust erosion, engineering hours spent on manual review, and liability exposure. Teams without agent eval pay this tax on every execution, whether they realize it or not.",
  },
  {
    question: "How do you calculate the eval tax?",
    answer: "The eval tax compounds across three dimensions: direct costs (manual review hours, incident response), indirect costs (delayed shipping, lost developer confidence), and risk costs (undetected PII exposure, hallucinated answers reaching users). Most teams underestimate it because the costs are distributed across the organization.",
  },
  {
    question: "How do you eliminate the eval tax?",
    answer: "By evaluating every agent output automatically with inline scoring rules. When eval runs on 100% of outputs with zero manual effort, the tax drops to near zero. The key is making eval effortless — if it requires setup, pipelines, or manual review, teams skip it and the tax compounds.",
  },
];

const TOC_ITEMS = [
  { id: "definition", label: "Definition", level: 2 as const },
  { id: "how-it-compounds", label: "How It Compounds", level: 2 as const },
  { id: "three-dimensions", label: "Three Dimensions", level: 2 as const },
  { id: "how-iris-helps", label: "How Iris Helps", level: 2 as const },
  { id: "related-concepts", label: "Related Concepts", level: 2 as const },
  { id: "faq", label: "FAQ", level: 2 as const },
];

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      headline: s("The Eval Tax: The Hidden Cost of Not Evaluating Agent Outputs"),
      description: s("The compounding cost of every unscored agent output — in trust, engineering hours, and liability."),
      url: "https://iris-eval.com/learn/eval-tax",
      datePublished: "2026-03-30",
      dateModified: "2026-03-30",
      author: { "@type": "Person", name: "Ian Parent", url: "https://x.com/iparentx" },
      publisher: { "@type": "Organization", name: "Iris", url: "https://iris-eval.com" },
      mainEntityOfPage: "https://iris-eval.com/learn/eval-tax",
    },
    {
      "@type": "FAQPage",
      mainEntity: FAQ_ITEMS.map((item) => ({
        "@type": "Question",
        name: s(item.question),
        acceptedAnswer: { "@type": "Answer", text: s(item.answer) },
      })),
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://iris-eval.com" },
        { "@type": "ListItem", position: 2, name: "Learn", item: "https://iris-eval.com/learn" },
        { "@type": "ListItem", position: 3, name: "The Eval Tax" },
      ],
    },
  ],
};

export default function LearnEvalTax(): React.ReactElement {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className="mx-auto max-w-6xl px-6 pt-32 pb-20 lg:pt-40">
        <div className="lg:grid lg:grid-cols-[1fr_240px] lg:gap-16">
        <article className="max-w-3xl text-[15px] leading-[1.8] text-text-secondary">

        {/* Breadcrumb */}
        <nav className="mb-8 text-sm text-text-muted">
          <Link href="/" className="hover:text-text-secondary transition-colors">Home</Link>
          <span className="mx-2">/</span>
          <Link href="/learn" className="hover:text-text-secondary transition-colors">Learn</Link>
          <span className="mx-2">/</span>
          <span className="text-text-primary">The Eval Tax</span>
        </nav>

        {/* Hero */}
        <h1 className="font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl">
          The Eval Tax
        </h1>
        <p className="mt-4 text-lg text-text-secondary max-w-2xl">
          The hidden, compounding cost every agent team pays when they don&apos;t evaluate output quality.
        </p>

        {/* Definition */}
        <SectionHeading id="definition" level={2}>Definition</SectionHeading>
        <CalloutBox variant="definition">
          <strong>The eval tax</strong> is the compounding cost of every unscored agent output — measured in trust erosion, engineering hours spent on manual review, and liability exposure. Every agent execution without evaluation adds to the balance. The longer you wait to start evaluating, the higher the accumulated debt.
        </CalloutBox>

        {/* How it compounds */}
        <SectionHeading id="how-it-compounds" level={2}>How It Compounds</SectionHeading>
        <p className="mt-4 text-text-secondary leading-relaxed">
          The eval tax isn&apos;t a one-time cost — it compounds. Each unscored output that reaches a user without evaluation creates downstream effects: support tickets from hallucinated answers, engineering time spent debugging agent behavior manually, compliance risk from undetected PII in outputs. These costs grow exponentially as agent usage scales.
        </p>
        <p className="mt-4 text-text-secondary leading-relaxed">
          The insidious part: most teams don&apos;t realize they&apos;re paying it. The costs are distributed across support, engineering, and legal — never attributed back to the missing eval layer. Teams describe symptoms (&quot;we spend too much time reviewing agent outputs&quot;) without connecting them to the root cause.
        </p>

        {/* Three dimensions */}
        <SectionHeading id="three-dimensions" level={2}>Three Dimensions of the Eval Tax</SectionHeading>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-border-default bg-surface-primary p-5">
            <h3 className="font-semibold text-text-primary mb-2">Direct Costs</h3>
            <p className="text-sm text-text-secondary">Manual review hours, incident response, output correction, customer support from bad agent answers.</p>
          </div>
          <div className="rounded-lg border border-border-default bg-surface-primary p-5">
            <h3 className="font-semibold text-text-primary mb-2">Indirect Costs</h3>
            <p className="text-sm text-text-secondary">Delayed shipping (fear of agent failures), lost developer confidence, slower iteration cycles.</p>
          </div>
          <div className="rounded-lg border border-border-default bg-surface-primary p-5">
            <h3 className="font-semibold text-text-primary mb-2">Risk Costs</h3>
            <p className="text-sm text-text-secondary">Undetected PII exposure, hallucinated answers in production, compliance violations, reputational damage.</p>
          </div>
        </div>

        {/* How Iris helps */}
        <SectionHeading id="how-iris-helps" level={2}>How Iris Helps</SectionHeading>
        <p className="mt-4 text-text-secondary leading-relaxed">
          Iris eliminates the eval tax by scoring every agent output automatically — inline, at the protocol layer. No SDK, no pipeline to build, no manual review. Add one line to your MCP config and every output gets evaluated for quality, safety, and cost.
        </p>
        <div className="mt-6 rounded-lg border border-border-default bg-[#0d1117] p-5 font-mono text-sm text-text-secondary overflow-x-auto">
          <pre>{`npx @iris-eval/mcp-server

# Every agent output is now scored for:
# - Completeness (response length, structure)
# - Relevance (topic consistency)
# - Safety (PII detection, prompt injection)
# - Cost (token usage, USD per trace)`}</pre>
        </div>

        <p className="mt-6 text-text-secondary leading-relaxed">
          <Link href="/blog/the-ai-eval-tax" className="text-iris-400 hover:text-iris-300 transition-colors">
            Read the deep dive: The AI Eval Tax &rarr;
          </Link>
        </p>

        {/* Related concepts */}
        <SectionHeading id="related-concepts" level={2}>Related Concepts</SectionHeading>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <VocabularyCard term="Eval Drift" definition="Quality degradation over time — one of the mechanisms that drives up the eval tax." href="/learn/eval-drift" />
          <VocabularyCard term="Eval Coverage" definition="The percentage of outputs being evaluated. 0% coverage = maximum eval tax." href="/learn/eval-coverage" />
          <VocabularyCard term="The Eval Gap" definition="The distance between demo and production — where the eval tax accumulates fastest." href="/learn/eval-gap" />
          <VocabularyCard term="Agent Eval" definition="The complete guide to evaluating AI agent outputs." href="/learn/agent-eval" />
        </div>

        {/* FAQ */}
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
