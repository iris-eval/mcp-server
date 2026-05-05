import type { Metadata } from "next";
import Link from "next/link";
import { OG_IMAGE_URL } from "@/lib/og";
import { SectionHeading } from "@/components/learn/section-heading";
import { CalloutBox } from "@/components/learn/callout-box";
import { VocabularyCard } from "@/components/learn/vocabulary-card";
import { FaqSection } from "@/components/learn/faq-section";
import { TableOfContents } from "@/components/learn/table-of-contents";

export const metadata: Metadata = {
  title: "Output Quality Score (OQS): The Single Number for Agent Quality — Iris",
  description: "What is the Output Quality Score? A composite metric that rolls completeness, relevance, safety, and cost into one number for every agent output.",
  alternates: { canonical: "https://iris-eval.com/learn/output-quality-score" },
  openGraph: { title: "Output Quality Score (OQS): The Single Number for Agent Quality", description: "A composite metric for every agent output.", url: "https://iris-eval.com/learn/output-quality-score", type: "article", images: [OG_IMAGE_URL] },
  twitter: { card: "summary_large_image", title: "Output Quality Score (OQS)", description: "A composite metric for every agent output.", images: [OG_IMAGE_URL], site: "@iris_eval" },
};

function s(value: unknown): string { return String(value ?? "").replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").slice(0, 500); }

const FAQ_ITEMS = [
  { question: "What is the Output Quality Score?", answer: "The Output Quality Score (OQS) is a composite metric that rolls completeness, relevance, safety, and cost into a single number between 0 and 1 for every agent output. It gives teams one signal to answer 'is this output good enough?' instead of checking multiple dimensions separately." },
  { question: "How is the OQS calculated?", answer: "OQS combines individual eval rule scores using weighted aggregation. Each dimension (completeness, relevance, safety, cost) contributes based on configurable weights. A safety violation can override the composite regardless of other scores — you can't average away a PII leak." },
  { question: "What is a good OQS?", answer: "There is no universal 'good' score — it depends on your use case. A customer-facing chatbot might require OQS > 0.85. An internal research assistant might be fine at 0.6. The value of OQS is not the absolute number but the trend over time and the ability to compare across agents." },
];

const TOC_ITEMS = [
  { id: "definition", label: "Definition", level: 2 as const },
  { id: "four-dimensions", label: "Four Dimensions", level: 2 as const },
  { id: "why-one-number", label: "Why One Number", level: 2 as const },
  { id: "how-iris-helps", label: "How Iris Helps", level: 2 as const },
  { id: "related-concepts", label: "Related Concepts", level: 2 as const },
  { id: "faq", label: "FAQ", level: 2 as const },
];

const jsonLd = { "@context": "https://schema.org", "@graph": [
  { "@type": "Article", headline: s("Output Quality Score (OQS): The Single Number for Agent Quality"), description: s("A composite metric that rolls completeness, relevance, safety, and cost into one number."), url: "https://iris-eval.com/learn/output-quality-score", datePublished: "2026-03-30", dateModified: "2026-03-30", author: { "@type": "Person", name: "Ian Parent", url: "https://x.com/iparentx" }, publisher: { "@type": "Organization", name: "Iris", url: "https://iris-eval.com" }, mainEntityOfPage: "https://iris-eval.com/learn/output-quality-score" },
  { "@type": "FAQPage", mainEntity: FAQ_ITEMS.map((item) => ({ "@type": "Question", name: s(item.question), acceptedAnswer: { "@type": "Answer", text: s(item.answer) } })) },
  { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: "https://iris-eval.com" }, { "@type": "ListItem", position: 2, name: "Learn", item: "https://iris-eval.com/learn" }, { "@type": "ListItem", position: 3, name: "Output Quality Score" }] },
]};

export default function LearnOQS(): React.ReactElement {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className="mx-auto max-w-6xl px-6 pt-32 pb-20 lg:pt-40">
        <div className="lg:grid lg:grid-cols-[1fr_240px] lg:gap-16">
        <article className="max-w-3xl text-[15px] leading-[1.8] text-text-secondary">
        <nav className="mb-8 text-sm text-text-muted">
          <Link href="/" className="hover:text-text-secondary transition-colors">Home</Link><span className="mx-2">/</span>
          <Link href="/learn" className="hover:text-text-secondary transition-colors">Learn</Link><span className="mx-2">/</span>
          <span className="text-text-primary">Output Quality Score</span>
        </nav>

        <h1 className="font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl">Output Quality Score</h1>
        <p className="mt-4 text-lg text-text-secondary max-w-2xl">One number that tells you if your agent&apos;s output is good enough.</p>

        <SectionHeading id="definition" level={2}>Definition</SectionHeading>
        <CalloutBox variant="definition">
          <strong>Output Quality Score (OQS)</strong> is a composite metric that rolls completeness, relevance, safety, and cost into a single number between 0 and 1 for every agent output. Instead of checking four dimensions separately, teams get one signal: is this output good enough?
        </CalloutBox>

        <SectionHeading id="four-dimensions" level={2}>Four Dimensions</SectionHeading>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-border-default bg-surface-primary p-5">
            <h3 className="font-semibold text-text-primary mb-2">Completeness</h3>
            <p className="text-sm text-text-secondary">Did the agent answer the full question? Is the response structurally complete? Minimum length, required sections, response format.</p>
          </div>
          <div className="rounded-lg border border-border-default bg-surface-primary p-5">
            <h3 className="font-semibold text-text-primary mb-2">Relevance</h3>
            <p className="text-sm text-text-secondary">Is the response on-topic? Does it address the actual input? Topic consistency, keyword presence, semantic alignment.</p>
          </div>
          <div className="rounded-lg border border-border-default bg-surface-primary p-5">
            <h3 className="font-semibold text-text-primary mb-2">Safety</h3>
            <p className="text-sm text-text-secondary">Is the output safe to show to users? PII detection, prompt injection patterns, hallucination markers, blocklist enforcement.</p>
          </div>
          <div className="rounded-lg border border-border-default bg-surface-primary p-5">
            <h3 className="font-semibold text-text-primary mb-2">Cost</h3>
            <p className="text-sm text-text-secondary">Is the output cost-efficient? Token usage relative to output quality, USD per trace, cost threshold enforcement.</p>
          </div>
        </div>

        <SectionHeading id="why-one-number" level={2}>Why One Number Matters</SectionHeading>
        <p className="mt-4 text-text-secondary leading-relaxed">
          Individual eval rules tell you what&apos;s wrong. The OQS tells you whether you should care. A response might score 0.9 on completeness but 0.3 on relevance — the OQS captures that it&apos;s a detailed answer to the wrong question. It&apos;s the signal you monitor on a dashboard, set alerts on, and report to stakeholders.
        </p>
        <CalloutBox variant="stat">
          Safety scores override the composite. A response with perfect completeness, relevance, and cost scores 0 on OQS if it contains PII. You can&apos;t average away a safety violation.
        </CalloutBox>

        <SectionHeading id="how-iris-helps" level={2}>How Iris Helps</SectionHeading>
        <p className="mt-4 text-text-secondary leading-relaxed">
          Iris scores every output across all four dimensions. The dashboard shows individual rule results and aggregate quality trends. The composite signal makes it easy to spot when overall quality is declining — even when individual dimensions look acceptable in isolation.
        </p>
        <p className="mt-6 text-text-secondary"><Link href="/blog/output-quality-score" className="text-iris-400 hover:text-iris-300 transition-colors">Read the deep dive: Output Quality Score &rarr;</Link></p>

        <SectionHeading id="related-concepts" level={2}>Related Concepts</SectionHeading>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <VocabularyCard term="Self-Calibrating Eval" definition="Individual dimension thresholds need calibration — which affects the composite OQS." href="/learn/self-calibrating-eval" />
          <VocabularyCard term="Eval Coverage" definition="OQS is only meaningful with 100% coverage — a composite score on sampled data misleads." href="/learn/eval-coverage" />
          <VocabularyCard term="The Eval Tax" definition="The OQS quantifies what you're losing — low scores show the tax in real-time." href="/learn/eval-tax" />
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
