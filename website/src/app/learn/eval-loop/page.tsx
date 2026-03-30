import type { Metadata } from "next";
import Link from "next/link";
import { SectionHeading } from "@/components/learn/section-heading";
import { CalloutBox } from "@/components/learn/callout-box";
import { VocabularyCard } from "@/components/learn/vocabulary-card";
import { FaqSection } from "@/components/learn/faq-section";
import { TableOfContents } from "@/components/learn/table-of-contents";

export const metadata: Metadata = {
  title: "The Eval Loop: Evals as the Loss Function for Agent Quality — Iris",
  description: "What is the eval loop? The continuous cycle of score, diagnose, calibrate, re-score that drives agent quality improvement over time.",
  alternates: { canonical: "https://iris-eval.com/learn/eval-loop" },
  openGraph: { title: "The Eval Loop: Evals as the Loss Function for Agent Quality", description: "The continuous cycle that drives agent quality improvement.", url: "https://iris-eval.com/learn/eval-loop", type: "article", images: ["/og-social-preview.png?v=3"] },
  twitter: { card: "summary_large_image", title: "The Eval Loop", description: "The continuous cycle that drives agent quality improvement.", images: ["/og-social-preview.png?v=3"], site: "@iris_eval" },
};

function s(value: unknown): string { return String(value ?? "").replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").slice(0, 500); }

const FAQ_ITEMS = [
  { question: "What is the eval loop?", answer: "The eval loop is the continuous cycle of scoring agent outputs, diagnosing failures, calibrating thresholds, and re-scoring. Unlike one-time evaluation gates, the eval loop treats evals as a continuous feedback signal — the loss function for agent quality." },
  { question: "How is the eval loop different from running evals once?", answer: "Running evals once tells you if an agent passed or failed at a point in time. The eval loop runs continuously, tracking quality trends over time. It catches drift, reveals calibration issues, and drives iterative improvement. One-time eval is a gate. The eval loop is a feedback system." },
  { question: "What are the four stages of the eval loop?", answer: "Score (run eval rules on every output), Diagnose (identify which rules fail and why), Calibrate (adjust thresholds based on observed distributions), Re-score (verify calibration improved results). Then repeat continuously." },
];

const TOC_ITEMS = [
  { id: "definition", label: "Definition", level: 2 as const },
  { id: "four-stages", label: "Four Stages", level: 2 as const },
  { id: "loop-not-gate", label: "Loop, Not Gate", level: 2 as const },
  { id: "how-iris-helps", label: "How Iris Helps", level: 2 as const },
  { id: "related-concepts", label: "Related Concepts", level: 2 as const },
  { id: "faq", label: "FAQ", level: 2 as const },
];

const jsonLd = { "@context": "https://schema.org", "@graph": [
  { "@type": "Article", headline: s("The Eval Loop: Evals as the Loss Function for Agent Quality"), description: s("The continuous cycle of score, diagnose, calibrate, re-score."), url: "https://iris-eval.com/learn/eval-loop", datePublished: "2026-03-30", dateModified: "2026-03-30", author: { "@type": "Person", name: "Ian Parent", url: "https://x.com/iparentx" }, publisher: { "@type": "Organization", name: "Iris", url: "https://iris-eval.com" }, mainEntityOfPage: "https://iris-eval.com/learn/eval-loop" },
  { "@type": "FAQPage", mainEntity: FAQ_ITEMS.map((item) => ({ "@type": "Question", name: s(item.question), acceptedAnswer: { "@type": "Answer", text: s(item.answer) } })) },
  { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: "https://iris-eval.com" }, { "@type": "ListItem", position: 2, name: "Learn", item: "https://iris-eval.com/learn" }, { "@type": "ListItem", position: 3, name: "The Eval Loop" }] },
]};

export default function LearnEvalLoop(): React.ReactElement {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className="relative mx-auto max-w-4xl px-6 pt-32 pb-20 lg:pt-40">
        <TableOfContents items={TOC_ITEMS} />
        <nav className="mb-8 text-sm text-text-muted">
          <Link href="/" className="hover:text-text-secondary transition-colors">Home</Link><span className="mx-2">/</span>
          <Link href="/learn" className="hover:text-text-secondary transition-colors">Learn</Link><span className="mx-2">/</span>
          <span className="text-text-primary">The Eval Loop</span>
        </nav>

        <h1 className="font-display text-4xl font-extrabold tracking-tight text-text-primary md:text-5xl">The Eval Loop</h1>
        <p className="mt-4 text-lg text-text-secondary max-w-2xl">Evals are the loss function for agent quality. The loop is how you optimize.</p>

        <SectionHeading id="definition" level={2}>Definition</SectionHeading>
        <CalloutBox variant="definition">
          <strong>The eval loop</strong> is the continuous cycle of scoring agent outputs, diagnosing failures, calibrating thresholds, and re-scoring. Most teams treat eval as a one-time gate. The eval loop treats it as a continuous feedback signal — the loss function that drives agent quality upward over time.
        </CalloutBox>

        <SectionHeading id="four-stages" level={2}>Four Stages</SectionHeading>
        <div className="mt-6 grid gap-4 sm:grid-cols-4">
          <div className="rounded-lg border border-border-default bg-surface-primary p-5 text-center">
            <div className="text-2xl font-bold text-iris-400 mb-2">1</div>
            <h3 className="font-semibold text-text-primary mb-1">Score</h3>
            <p className="text-xs text-text-secondary">Run eval rules on every output. Capture pass/fail and scores.</p>
          </div>
          <div className="rounded-lg border border-border-default bg-surface-primary p-5 text-center">
            <div className="text-2xl font-bold text-iris-400 mb-2">2</div>
            <h3 className="font-semibold text-text-primary mb-1">Diagnose</h3>
            <p className="text-xs text-text-secondary">Identify which rules fail most. Find patterns in failures.</p>
          </div>
          <div className="rounded-lg border border-border-default bg-surface-primary p-5 text-center">
            <div className="text-2xl font-bold text-iris-400 mb-2">3</div>
            <h3 className="font-semibold text-text-primary mb-1">Calibrate</h3>
            <p className="text-xs text-text-secondary">Adjust thresholds based on real distributions. Tighten or loosen.</p>
          </div>
          <div className="rounded-lg border border-border-default bg-surface-primary p-5 text-center">
            <div className="text-2xl font-bold text-iris-400 mb-2">4</div>
            <h3 className="font-semibold text-text-primary mb-1">Re-score</h3>
            <p className="text-xs text-text-secondary">Verify calibration improved results. Then repeat continuously.</p>
          </div>
        </div>

        <SectionHeading id="loop-not-gate" level={2}>Loop, Not Gate</SectionHeading>
        <p className="mt-4 text-text-secondary leading-relaxed">
          A gate checks once: pass or fail. A loop checks continuously and feeds back into improvement. The teams that build the eval loop first end up with a compounding advantage — they know what actually works, not what sounds like it should work. Each iteration gets tighter because you&apos;re working from data, not vibes.
        </p>
        <CalloutBox variant="stat">
          The eval loop is to agent quality what the training loop is to model quality. You wouldn&apos;t train a model without a loss function. Don&apos;t ship an agent without one either.
        </CalloutBox>

        <SectionHeading id="how-iris-helps" level={2}>How Iris Helps</SectionHeading>
        <p className="mt-4 text-text-secondary leading-relaxed">
          Iris provides the scoring layer for the eval loop. Every output is scored automatically — the &quot;Score&quot; stage runs with zero effort. The dashboard provides the &quot;Diagnose&quot; stage — see which rules fail, when, and at what rate. Calibration and re-scoring happen as you adjust rules and watch the impact in real-time.
        </p>
        <p className="mt-6 text-text-secondary"><Link href="/blog/the-eval-loop" className="text-iris-400 hover:text-iris-300 transition-colors">Read the deep dive: The Eval Loop &rarr;</Link></p>

        <SectionHeading id="related-concepts" level={2}>Related Concepts</SectionHeading>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <VocabularyCard term="Eval Drift" definition="The loop catches drift — quality degradation becomes visible as a downward trend." href="/learn/eval-drift" />
          <VocabularyCard term="Self-Calibrating Eval" definition="The next evolution — automated threshold calibration within the loop." href="/learn/self-calibrating-eval" />
          <VocabularyCard term="Eval-Driven Development" definition="EDD starts the loop. Once rules are defined, the loop keeps them honest." href="/learn/eval-driven-development" />
          <VocabularyCard term="Agent Eval" definition="The complete guide to evaluating AI agent outputs." href="/learn/agent-eval" />
        </div>

        <SectionHeading id="faq" level={2}>Frequently Asked Questions</SectionHeading>
        <FaqSection items={FAQ_ITEMS} />
      </div>
    </>
  );
}
