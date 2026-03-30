import type { Metadata } from "next";
import Link from "next/link";
import { SectionHeading } from "@/components/learn/section-heading";
import { CalloutBox } from "@/components/learn/callout-box";
import { VocabularyCard } from "@/components/learn/vocabulary-card";
import { FaqSection } from "@/components/learn/faq-section";
import { TableOfContents } from "@/components/learn/table-of-contents";

export const metadata: Metadata = {
  title: "Eval Drift: The Silent Quality Killer for AI Agents — Iris",
  description:
    "What is eval drift? The silent degradation of agent quality caused by upstream model changes you can't control. Learn how to detect and prevent it.",
  alternates: { canonical: "https://iris-eval.com/learn/eval-drift" },
  openGraph: {
    title: "Eval Drift: The Silent Quality Killer for AI Agents",
    description: "The silent degradation of agent quality caused by upstream model changes.",
    url: "https://iris-eval.com/learn/eval-drift",
    type: "article",
    images: ["/og-social-preview.png?v=3"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Eval Drift: The Silent Quality Killer for AI Agents",
    description: "The silent degradation of agent quality caused by upstream model changes.",
    images: ["/og-social-preview.png?v=3"],
    site: "@iris_eval",
  },
};

function s(value: unknown): string {
  return String(value ?? "").replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").slice(0, 500);
}

const FAQ_ITEMS = [
  {
    question: "What is eval drift?",
    answer: "Eval drift is the silent degradation of agent output quality over time, even when your code and prompts haven't changed. It's caused by upstream model updates, shifting input distributions, and environmental changes that alter how your agent behaves without any visible change in your codebase.",
  },
  {
    question: "What causes eval drift?",
    answer: "Three primary causes: (1) upstream model updates — providers update models without notice, changing output behavior; (2) input distribution shift — real-world usage patterns differ from development data; (3) environmental changes — API rate limits, context window changes, and dependency updates that affect agent behavior indirectly.",
  },
  {
    question: "How do you detect eval drift?",
    answer: "By running the same evaluation rules on every output continuously and tracking scores over time. When average scores trend downward without code changes, that's drift. Iris scores every output inline, making drift visible in the dashboard as a trend rather than discovered after user complaints.",
  },
];

const TOC_ITEMS = [
  { id: "definition", label: "Definition", level: 2 as const },
  { id: "causes", label: "What Causes It", level: 2 as const },
  { id: "detection", label: "Detection", level: 2 as const },
  { id: "how-iris-helps", label: "How Iris Helps", level: 2 as const },
  { id: "related-concepts", label: "Related Concepts", level: 2 as const },
  { id: "faq", label: "FAQ", level: 2 as const },
];

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      headline: s("Eval Drift: The Silent Quality Killer for AI Agents"),
      description: s("The silent degradation of agent quality caused by upstream model changes you can't control."),
      url: "https://iris-eval.com/learn/eval-drift",
      datePublished: "2026-03-30",
      dateModified: "2026-03-30",
      author: { "@type": "Person", name: "Ian Parent", url: "https://x.com/iparentx" },
      publisher: { "@type": "Organization", name: "Iris", url: "https://iris-eval.com" },
      mainEntityOfPage: "https://iris-eval.com/learn/eval-drift",
    },
    {
      "@type": "FAQPage",
      mainEntity: FAQ_ITEMS.map((item) => ({
        "@type": "Question", name: s(item.question),
        acceptedAnswer: { "@type": "Answer", text: s(item.answer) },
      })),
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://iris-eval.com" },
        { "@type": "ListItem", position: 2, name: "Learn", item: "https://iris-eval.com/learn" },
        { "@type": "ListItem", position: 3, name: "Eval Drift" },
      ],
    },
  ],
};

export default function LearnEvalDrift(): React.ReactElement {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className="mx-auto max-w-6xl px-6 pt-32 pb-20 lg:pt-40">
        <div className="lg:grid lg:grid-cols-[1fr_240px] lg:gap-16">
        <article className="max-w-3xl text-[15px] leading-[1.8] text-text-secondary">
        <nav className="mb-8 text-sm text-text-muted">
          <Link href="/" className="hover:text-text-secondary transition-colors">Home</Link>
          <span className="mx-2">/</span>
          <Link href="/learn" className="hover:text-text-secondary transition-colors">Learn</Link>
          <span className="mx-2">/</span>
          <span className="text-text-primary">Eval Drift</span>
        </nav>

        <h1 className="font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl">Eval Drift</h1>
        <p className="mt-4 text-lg text-text-secondary max-w-2xl">The silent quality killer — when agent output degrades without any code changes.</p>

        <SectionHeading id="definition" level={2}>Definition</SectionHeading>
        <CalloutBox variant="definition">
          <strong>Eval drift</strong> is the silent degradation of agent output quality over time, even when your code and prompts haven&apos;t changed. Upstream model updates, shifting input distributions, and environmental changes alter agent behavior without any visible change in your codebase. Without continuous evaluation, drift goes undetected until users report failures.
        </CalloutBox>

        <SectionHeading id="causes" level={2}>What Causes Eval Drift</SectionHeading>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-border-default bg-surface-primary p-5">
            <h3 className="font-semibold text-text-primary mb-2">Model Updates</h3>
            <p className="text-sm text-text-secondary">Providers update models without notice. GPT-4 today is not GPT-4 from last month. Same API, different behavior.</p>
          </div>
          <div className="rounded-lg border border-border-default bg-surface-primary p-5">
            <h3 className="font-semibold text-text-primary mb-2">Input Shift</h3>
            <p className="text-sm text-text-secondary">Real-world usage patterns differ from development. Edge cases accumulate. The distribution your prompts were tuned for drifts.</p>
          </div>
          <div className="rounded-lg border border-border-default bg-surface-primary p-5">
            <h3 className="font-semibold text-text-primary mb-2">Environment Changes</h3>
            <p className="text-sm text-text-secondary">API rate limits, context window changes, dependency updates, and infrastructure shifts that affect behavior indirectly.</p>
          </div>
        </div>

        <SectionHeading id="detection" level={2}>Detection</SectionHeading>
        <p className="mt-4 text-text-secondary leading-relaxed">
          Eval drift is invisible without continuous scoring. The only way to detect it is to run the same evaluation rules on every output and track scores over time. When average quality scores trend downward without code changes, that&apos;s drift. A single failing output might be noise — a downward trend over days or weeks is signal.
        </p>
        <CalloutBox variant="stat">
          Eval drift is the #1 reason agents that work in demos fail in production. The demo environment is frozen. Production is not.
        </CalloutBox>

        <SectionHeading id="how-iris-helps" level={2}>How Iris Helps</SectionHeading>
        <p className="mt-4 text-text-secondary leading-relaxed">
          Iris scores every output inline, making drift visible as a trend in the dashboard. When scores drop over time, you see it immediately — not weeks later from user complaints. The &quot;All Time&quot; period view lets you compare current performance against historical baselines.
        </p>
        <p className="mt-6 text-text-secondary leading-relaxed">
          <Link href="/blog/eval-drift-the-silent-quality-killer" className="text-iris-400 hover:text-iris-300 transition-colors">Read the deep dive: Eval Drift &rarr;</Link>
        </p>

        <SectionHeading id="related-concepts" level={2}>Related Concepts</SectionHeading>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <VocabularyCard term="Self-Calibrating Eval" definition="The pattern that solves drift — eval rules that adapt thresholds based on observed distributions." href="/learn/self-calibrating-eval" />
          <VocabularyCard term="The Eval Loop" definition="The continuous cycle that catches drift: score, diagnose, calibrate, re-score." href="/learn/eval-loop" />
          <VocabularyCard term="The Eval Tax" definition="Drift compounds the eval tax — undetected quality degradation increases costs over time." href="/learn/eval-tax" />
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
