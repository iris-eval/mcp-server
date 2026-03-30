import type { Metadata } from "next";
import Link from "next/link";
import { SectionHeading } from "@/components/learn/section-heading";
import { CalloutBox } from "@/components/learn/callout-box";
import { VocabularyCard } from "@/components/learn/vocabulary-card";
import { FaqSection } from "@/components/learn/faq-section";
import { TableOfContents } from "@/components/learn/table-of-contents";

export const metadata: Metadata = {
  title: "Self-Calibrating Eval: The End of Manual Threshold Tuning — Iris",
  description: "What is self-calibrating eval? Eval rules that monitor their own scoring distribution and recommend threshold adjustments — always human-approved.",
  alternates: { canonical: "https://iris-eval.com/learn/self-calibrating-eval" },
  openGraph: { title: "Self-Calibrating Eval: The End of Manual Threshold Tuning", description: "Eval rules that adapt thresholds based on observed distributions.", url: "https://iris-eval.com/learn/self-calibrating-eval", type: "article", images: ["/og-social-preview.png?v=3"] },
  twitter: { card: "summary_large_image", title: "Self-Calibrating Eval", description: "Eval rules that adapt thresholds based on observed distributions.", images: ["/og-social-preview.png?v=3"], site: "@iris_eval" },
};

function s(value: unknown): string { return String(value ?? "").replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").slice(0, 500); }

const FAQ_ITEMS = [
  { question: "What is self-calibrating eval?", answer: "Self-calibrating eval is the pattern where evaluation rules monitor their own scoring distribution and recommend threshold adjustments. Instead of manually tuning thresholds, the system observes real output distributions and suggests when thresholds should tighten or loosen — always with human approval." },
  { question: "Why do eval thresholds need calibration?", answer: "Static thresholds break over time. A completeness threshold set at 0.7 might pass everything today and fail everything next month — not because quality changed, but because the distribution shifted. Self-calibrating eval detects this automatically." },
  { question: "Is self-calibrating eval fully automated?", answer: "No — and intentionally so. The system recommends adjustments but a human approves them. This keeps humans in the loop for quality decisions while eliminating the manual work of monitoring distributions and guessing at thresholds." },
];

const TOC_ITEMS = [
  { id: "definition", label: "Definition", level: 2 as const },
  { id: "why-thresholds-break", label: "Why Thresholds Break", level: 2 as const },
  { id: "the-pattern", label: "The Pattern", level: 2 as const },
  { id: "how-iris-helps", label: "How Iris Helps", level: 2 as const },
  { id: "related-concepts", label: "Related Concepts", level: 2 as const },
  { id: "faq", label: "FAQ", level: 2 as const },
];

const jsonLd = { "@context": "https://schema.org", "@graph": [
  { "@type": "Article", headline: s("Self-Calibrating Eval: The End of Manual Threshold Tuning"), description: s("Eval rules that monitor their own scoring distribution and recommend adjustments."), url: "https://iris-eval.com/learn/self-calibrating-eval", datePublished: "2026-03-30", dateModified: "2026-03-30", author: { "@type": "Person", name: "Ian Parent", url: "https://x.com/iparentx" }, publisher: { "@type": "Organization", name: "Iris", url: "https://iris-eval.com" }, mainEntityOfPage: "https://iris-eval.com/learn/self-calibrating-eval" },
  { "@type": "FAQPage", mainEntity: FAQ_ITEMS.map((item) => ({ "@type": "Question", name: s(item.question), acceptedAnswer: { "@type": "Answer", text: s(item.answer) } })) },
  { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: "https://iris-eval.com" }, { "@type": "ListItem", position: 2, name: "Learn", item: "https://iris-eval.com/learn" }, { "@type": "ListItem", position: 3, name: "Self-Calibrating Eval" }] },
]};

export default function LearnSelfCalibratingEval(): React.ReactElement {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className="mx-auto max-w-6xl px-6 pt-32 pb-20 lg:pt-40">
        <div className="lg:grid lg:grid-cols-[1fr_240px] lg:gap-16">
        <article className="max-w-3xl text-[15px] leading-[1.8] text-text-secondary">
        <nav className="mb-8 text-sm text-text-muted">
          <Link href="/" className="hover:text-text-secondary transition-colors">Home</Link><span className="mx-2">/</span>
          <Link href="/learn" className="hover:text-text-secondary transition-colors">Learn</Link><span className="mx-2">/</span>
          <span className="text-text-primary">Self-Calibrating Eval</span>
        </nav>

        <h1 className="font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl">Self-Calibrating Eval</h1>
        <p className="mt-4 text-lg text-text-secondary max-w-2xl">Eval rules that know when their own thresholds are wrong — and tell you how to fix them.</p>

        <SectionHeading id="definition" level={2}>Definition</SectionHeading>
        <CalloutBox variant="definition">
          <strong>Self-calibrating eval</strong> is the pattern where evaluation rules monitor their own scoring distribution and recommend threshold adjustments. Instead of manually tuning thresholds based on intuition, the system observes real output distributions and suggests when thresholds should tighten or loosen. Adjustments are always human-approved.
        </CalloutBox>

        <SectionHeading id="why-thresholds-break" level={2}>Why Static Thresholds Break</SectionHeading>
        <p className="mt-4 text-text-secondary leading-relaxed">
          A completeness threshold set at 0.7 might be perfect today — passing genuinely good outputs and catching bad ones. Three weeks later, the same threshold passes everything (because model quality improved) or fails everything (because input patterns shifted). The threshold didn&apos;t change. The world around it did. This is <Link href="/learn/eval-drift" className="text-iris-400 hover:text-iris-300">eval drift</Link> at the threshold level.
        </p>
        <CalloutBox variant="stat">
          A 100% pass rate is not a sign of quality — it&apos;s a sign your thresholds need tightening. A 100% fail rate is not a sign of failure — it&apos;s a sign your thresholds need loosening. Both are calibration problems.
        </CalloutBox>

        <SectionHeading id="the-pattern" level={2}>The Pattern</SectionHeading>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-border-default bg-surface-primary p-5 text-center">
            <div className="text-2xl font-bold text-iris-400 mb-2">1</div>
            <h3 className="font-semibold text-text-primary mb-1">Monitor</h3>
            <p className="text-xs text-text-secondary">Track the distribution of scores for each eval rule over time.</p>
          </div>
          <div className="rounded-lg border border-border-default bg-surface-primary p-5 text-center">
            <div className="text-2xl font-bold text-iris-400 mb-2">2</div>
            <h3 className="font-semibold text-text-primary mb-1">Detect</h3>
            <p className="text-xs text-text-secondary">Flag when pass rates hit extremes (100% or 0%) or distributions shift significantly.</p>
          </div>
          <div className="rounded-lg border border-border-default bg-surface-primary p-5 text-center">
            <div className="text-2xl font-bold text-iris-400 mb-2">3</div>
            <h3 className="font-semibold text-text-primary mb-1">Recommend</h3>
            <p className="text-xs text-text-secondary">Suggest adjusted thresholds based on observed data. Human approves or rejects.</p>
          </div>
        </div>

        <SectionHeading id="how-iris-helps" level={2}>How Iris Helps</SectionHeading>
        <p className="mt-4 text-text-secondary leading-relaxed">
          Iris provides the scoring data that powers self-calibrating eval. Every output is scored with the same rules, building the distribution data needed to detect calibration issues. The dashboard shows pass/fail rates over time — when a rule passes 100% of outputs, it&apos;s visible immediately.
        </p>
        <p className="mt-6 text-text-secondary"><Link href="/blog/self-calibrating-eval" className="text-iris-400 hover:text-iris-300 transition-colors">Read the deep dive: Self-Calibrating Eval &rarr;</Link></p>

        <SectionHeading id="related-concepts" level={2}>Related Concepts</SectionHeading>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <VocabularyCard term="Eval Drift" definition="Self-calibrating eval is the solution to threshold-level drift." href="/learn/eval-drift" />
          <VocabularyCard term="The Eval Loop" definition="Self-calibration is the 'Calibrate' stage of the eval loop, automated." href="/learn/eval-loop" />
          <VocabularyCard term="Output Quality Score" definition="A composite metric that benefits from calibrated individual rules." href="/learn/output-quality-score" />
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
